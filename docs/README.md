# CaptionDoor documentation

Start with the [project README](../README.md) for the product, quick start and current evidence summary. These guides separate everyday local development, implementation contracts and opt-in provider operations.

## Run and evaluate locally

| Guide                                     | Use it for                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| [Local development](local-development.md) | Setup, ports, Docker application processes, verification, shutdown and troubleshooting |
| [Judge replay](judging-replay.md)         | A credential-free synthetic journey through the real local application                 |
| [Demo script](demo-script.md)             | A concise narrated caption-first walkthrough                                           |
| [Verification log](test-results.md)       | Dated commands, results, failures, skips and evidence locations                        |
| [Contributing](../CONTRIBUTING.md)        | Repository boundaries and checks before a change                                       |

## Understand the implementation

| Guide                                                   | Use it for                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| [Architecture](architecture.md)                         | Runtime boundaries, communication flow and dispatch topology     |
| [Data model](data-model.md)                             | DynamoDB keys, access patterns, atomicity and expiry             |
| [HTTP contract](http-contract.md)                       | Authentication, endpoints and command behavior                   |
| [Integration contracts](integration-contracts.md)       | Ring, audio, transcription and push boundaries                   |
| [Audio pipeline](audio.md)                              | Incoming tracks, resampling, PCM transport and caption lifecycle |
| [Security and privacy](security-and-privacy.md)         | Consent, authorization, credential handling and deletion         |
| [Compatibility matrix](compatibility-matrix.md)         | Implemented behavior versus browser/provider/device observations |
| [Assumptions and blockers](assumptions-and-blockers.md) | Current scope and remaining evidence gates                       |

## Provider and AWS operations

These tools can contact external services, persist cloud data or incur charges. Their historical approval flags and receipts describe a specific operator's completed test; they do not authorize another run or configure a fresh clone.

| Guide                                                         | Status and purpose                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [Remote provider session](remote-provider-session.md)         | Executed single-attempt checkpoint, retained AWS resources, missing media and verified own-data cleanup                    |
| [Local provider session](provider-session.md)                 | Historical Local launcher; its fixed paid-test scope is retired                                                            |
| [Playground audio proof](playground-audio-proof.md)           | Historical preparation, source attribution and provider acceptance criteria; current status links to the remote checkpoint |
| [Ring smoke procedure](ring-smoke.md)                         | Scope selection and evidence requirements for a separately authorized provider test                                        |
| [Remote DynamoDB runbook](remote-dynamodb-runbook.md)         | Separate, unexecuted database-only `remote-demo` proposal                                                                  |
| [Remote DynamoDB preparation](remote-dynamodb-preparation.md) | Supporting preparation for that separate proposal                                                                          |

For external review, [submission readiness](submission-checklist.md) records the remaining project-specific evidence gaps. [Ring compliance gaps](ring-compliance-gaps.md), [the access checkpoint](ring-access-checkpoint.md), [tool feedback](tool-feedback.md) and [October 22 polish notes](polish-20261022.md) retain dated review history.

## Reading evidence correctly

The newest dated checkpoint for a given layer supersedes earlier status statements. Test counts and timings belong to their recorded revision and run. Local fixtures, mocked SDK transport, actual DynamoDB Local, remote database reads and provider/device observations are distinct evidence layers.

Paths under `output/` refer to ignored operator-local receipts, reports and screenshots. They are not included in a clone. Do not treat an unavailable receipt, an implemented adapter or a synthesized template as a newly reproduced result. The public repository contains source and sanitized narrative checkpoints, never runtime secrets or private evidence bundles.
