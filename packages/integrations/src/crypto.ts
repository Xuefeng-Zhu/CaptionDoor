import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { AppError } from '@captiondoor/domain';

export type CredentialContext = { householdId: string; integrationId: string };
export type CredentialEnvelope =
  | { version: 1; mode: 'kms'; keyId: string; ciphertext: string }
  | { version: 1; mode: 'development'; iv: string; tag: string; ciphertext: string };
export type CredentialCipherOptions =
  | { mode: 'kms'; keyId: string; region: string; client?: Pick<KMSClient, 'send'> }
  | { mode: 'development'; keyBase64: string; nodeEnv?: string };

function encryptionContext(context: CredentialContext): Record<string, string> {
  if (!context.householdId || !context.integrationId) throw new AppError('CREDENTIAL_CONTEXT_REQUIRED', 500, 'Credential scope is required.');
  return { application: 'CaptionDoor', provider: 'Ring', householdId: context.householdId, integrationId: context.integrationId };
}
/** Envelopes, never decrypted values, are stored in CaptionDoorConfig. */
export class CredentialCipher {
  private readonly kms?: Pick<KMSClient, 'send'>;
  private readonly developmentKey?: Buffer;
  constructor(private readonly options: CredentialCipherOptions) {
    if (options.mode === 'kms') {
      if (!options.keyId || !options.region) throw new AppError('CREDENTIAL_ENCRYPTION_REQUIRED', 503, 'KMS credential encryption is not configured.');
      this.kms = options.client ?? new KMSClient({ region: options.region });
    } else {
      if ((options.nodeEnv ?? process.env.NODE_ENV) === 'production') throw new AppError('DEV_CREDENTIAL_CIPHER_FORBIDDEN', 500, 'Production requires KMS credential encryption.');
      if (!/^[A-Za-z0-9+/]{43}=$/.test(options.keyBase64)) throw new AppError('CREDENTIAL_ENCRYPTION_REQUIRED', 503, 'Set a separate 32-byte development encryption key.');
      this.developmentKey = Buffer.from(options.keyBase64, 'base64');
      if (this.developmentKey.length !== 32) throw new AppError('CREDENTIAL_ENCRYPTION_REQUIRED', 503, 'Development encryption key must be 32 bytes.');
    }
  }
  async encrypt(value: Record<string, unknown>, context: CredentialContext): Promise<CredentialEnvelope> {
    const aad = encryptionContext(context), plaintext = Buffer.from(JSON.stringify(value));
    if (plaintext.length > 4096) throw new AppError('CREDENTIAL_TOO_LARGE', 400, 'Credential payload exceeds the encryption limit.');
    try {
      if (this.options.mode === 'kms') {
        const result = await this.kms!.send(new EncryptCommand({ KeyId: this.options.keyId, Plaintext: plaintext, EncryptionContext: aad }));
        if (!result.CiphertextBlob) throw new Error('No ciphertext');
        return { version: 1, mode: 'kms', keyId: this.options.keyId, ciphertext: Buffer.from(result.CiphertextBlob).toString('base64') };
      }
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.developmentKey!, iv);
      cipher.setAAD(Buffer.from(JSON.stringify(aad)));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { version: 1, mode: 'development', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    } catch { throw new AppError('CREDENTIAL_ENCRYPTION_FAILED', 503, 'Credentials could not be encrypted.'); }
    finally { plaintext.fill(0); }
  }
  async decrypt<T extends Record<string, unknown>>(envelope: CredentialEnvelope, context: CredentialContext): Promise<T> {
    const aad = encryptionContext(context);
    if (envelope.version !== 1 || envelope.mode !== this.options.mode) throw new AppError('CREDENTIAL_ENCRYPTION_MISMATCH', 503, 'Credential encryption configuration does not match.');
    let plaintext: Buffer | undefined;
    try {
      if (envelope.mode === 'kms' && this.options.mode === 'kms') {
        if (envelope.keyId !== this.options.keyId) throw new Error('Wrong key');
        const result = await this.kms!.send(new DecryptCommand({ KeyId: this.options.keyId, CiphertextBlob: Buffer.from(envelope.ciphertext, 'base64'), EncryptionContext: aad }));
        if (!result.Plaintext) throw new Error('No plaintext');
        plaintext = Buffer.from(result.Plaintext);
      } else if (envelope.mode === 'development') {
        const decipher = createDecipheriv('aes-256-gcm', this.developmentKey!, Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from(JSON.stringify(aad))); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      }
      if (!plaintext) throw new Error('Invalid envelope');
      const value: unknown = JSON.parse(plaintext.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid value');
      return value as T;
    } catch { throw new AppError('CREDENTIAL_DECRYPTION_FAILED', 503, 'Credentials could not be decrypted. Re-linking may be required.'); }
    finally { plaintext?.fill(0); }
  }
}

export function credentialCipherFromEnv(env: Record<string, string | undefined> = process.env): CredentialCipher {
  if (env.CREDENTIAL_ENCRYPTION_MODE === 'kms') return new CredentialCipher({ mode: 'kms', keyId: env.RING_KMS_KEY_ID ?? '', region: env.AWS_REGION ?? '' });
  if (env.CREDENTIAL_ENCRYPTION_MODE === 'development') return new CredentialCipher({ mode: 'development', keyBase64: env.DEV_CREDENTIAL_KEY ?? '', nodeEnv: env.NODE_ENV });
  throw new AppError('CREDENTIAL_ENCRYPTION_REQUIRED', 503, 'Select KMS encryption or an explicit local development key before linking Ring.');
}
export function encryptRingCredentials(value: Record<string, unknown>, context: CredentialContext, env: Record<string, string | undefined> = process.env): Promise<CredentialEnvelope> {
  return credentialCipherFromEnv(env).encrypt(value, context);
}
export function decryptRingCredentials<T extends Record<string, unknown>>(envelope: CredentialEnvelope, context: CredentialContext, env: Record<string, string | undefined> = process.env): Promise<T> {
  return credentialCipherFromEnv(env).decrypt<T>(envelope, context);
}
