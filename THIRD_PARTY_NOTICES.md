# Third-party notices

CaptionDoor's new source is licensed under MIT (see LICENSE). No pre-existing project/license was found at the requested case-insensitive path. This does not relicense third-party dependencies, container software, trademarks or provider content. No external artwork, fonts, Ring sample source or licensed media was copied into the project. SVG/interface artwork is original code.

Pinned exact versions and transitive packages are recorded in `pnpm-lock.yaml`. Each installed dependency retains its package LICENSE/NOTICE files; distributions must retain those files and any required source/license obligations. Major direct dependencies include:

| Dependency | License family (verify included package notices when redistributing) |
| --- | --- |
| Next.js, React, React DOM | MIT |
| AWS SDK v3 clients and DocumentClient, AWS CDK, TypeScript | Apache-2.0 |
| openid-client, Zod, ws, web-push, qrcode | MIT |
| Tailwind CSS, PostCSS, Autoprefixer, tsx, Vitest | MIT |
| Playwright | Apache-2.0 |
| axe-core / @axe-core/playwright | MPL-2.0 |
| TypeScript community type definitions | MIT |

Docker references separate official distributions: Node.js (including its bundled component notices), Amazon DynamoDB Local (AWS distribution terms/notices) and Caddy (Apache-2.0 plus bundled component licenses). Their images are downloaded from the publishers; the repository does not embed/relicense them. DynamoDB Local is used only as the local implementation of the DynamoDB API and is not substituted by another persistent application database.

Ring/Amazon/AWS, Cognito, DynamoDB and Transcribe names identify provider integrations and do not imply endorsement or grant trademark/media rights. Provider API terms, account access permissions, privacy/content policies and any device or official simulator requirements apply separately. Consult the original package/image LICENSE and NOTICE files rather than treating this summary as the complete license text.
