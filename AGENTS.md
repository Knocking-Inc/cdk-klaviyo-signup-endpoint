# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

AWS CDK (v2) project that deploys a serverless Klaviyo email signup endpoint. It consists of a single Lambda function behind API Gateway, a DynamoDB table for counters and audit records, and Secrets Manager integration for domain-specific Klaviyo credentials.

## Common Commands

- `npm install` — Install CDK dependencies (run in root and also `cd lambda && npm install`)
- `npm run build` — Compile TypeScript (`tsc`)
- `npm run watch` — Compile TypeScript in watch mode
- `npm test` — Run Jest tests (matches `test/**/*.test.js`)
- `npm run deploy` — Deploy the CDK stack (`cdk deploy`)
- `npm run diff` — Show CDK stack diff (`cdk diff`)
- `npm run destroy` — Tear down the stack (`cdk destroy`)
- `./scripts/deploy.sh` — Full deployment script that installs deps, builds, and deploys

## Architecture

### CDK Stack (`lib/klaviyo-signup-stack.ts`)

- `KlaviyoSignupStack` defines all infrastructure:
  - **DynamoDB** table `klaviyo-signup` with PK `id` and SK `type`. Two GSIs: `DomainStatusIndex` (domain, status) and `StatusTimestampIndex` (status, timestamp). PAY_PER_REQUEST billing with PITR enabled.
  - **Lambda** (`lambda/index.js`, Node.js 20, `index.handler`) packaged from `lambda/` directory. The Lambda code is plain JS and depends on `@aws-sdk/*` and `axios`.
  - **API Gateway** REST API with two resources: `POST /signup` (API key required) and `POST /query` (no API key required). CORS preflight is handled by the Lambda.
  - **Usage Plan** with rate limit 100 req/s, burst 200, daily quota 500k.
  - **ApiKey** created via CDK. A `AwsCustomResource` is used to fetch the API key value at deploy time so it can be injected into the Lambda environment (`API_KEY`).
  - **Secrets Manager** read access granted to the Lambda for the secret `prod/klaviyosignups`.

### Lambda Handler (`lambda/index.js`)

A single `exports.handler` routes requests based on `event.resource` / `event.path`:

- `POST /signup` — `handleSignupRequest`
- `POST /query` — `handleQueryRequest`
- `OPTIONS` — CORS preflight (returns `*`)

Key behavioral details:

- **Domain allowlist**: `ALLOWED_DOMAINS` env var is a comma-separated list. Only allowed domains can sign up. The `query` endpoint does not enforce the allowlist but still validates domain format.
- **Secrets caching**: Secrets are fetched from Secrets Manager and cached in Lambda memory for 5 minutes (`CACHE_DURATION`). Each domain requires three keys in the secret: `KlaviyoPrivateKey_{domain}`, `KlaviyoListId_{domain}`, `KlavioSiteID_{domain}`.
- **Sequence numbers**: Generated via DynamoDB `UpdateCommand` with `if_not_exists(#count, :start) + :incr`. The starting counter is **23420** (hardcoded in `lambda/index.js`).
- **Idempotency**: On signup, the Lambda first checks if a `success` record already exists for the email+domain hash. If found, it returns the existing sequence number with `alreadySubscribed: true`. If the prior record has a non-success status, it proceeds with a new signup.
- **Email hashing**: Stored as `SHA-256(email.toLowerCase() + domain.toLowerCase())`.
- **Query retry**: The query endpoint accepts `?retry=true` or `?retry=1`. When enabled, it retries every 1 second for up to 4 seconds (5 total attempts) before returning `found: false`. This is to handle DynamoDB eventual consistency after a signup.
- **CORS**: The Lambda dynamically sets `Access-Control-Allow-Origin` based on the domain. For production domains it returns `https://{domain}`. Localhost/Framer origins get `*`.
- **Klaviyo API**: Uses the bulk subscription job endpoint (`/api/profile-subscription-bulk-create-jobs`) with `revision: 2025-04-15`.

### Tests (`test/`)

- `signup.test.js` — Comprehensive validation tests (API key, email/domain format, CORS, duplicate handling, query endpoint)
- `query-retry.test.js` — Tests retry logic with mocked timers (`jest.useFakeTimers`)
- `query-retry-simple.test.js` — Standalone unit tests for retry loop math and setTimeout mocking

Tests mock AWS SDK clients and `axios` via `jest.mock`.

## Multi-Domain Configuration

To support additional domains, you must update **three** places:

1. `lib/klaviyo-signup-stack.ts`: Add the domain to `ALLOWED_DOMAINS` env var.
2. AWS Secrets Manager: Add `KlaviyoPrivateKey_{domain}`, `KlaviyoListId_{domain}`, and `KlavioSiteID_{domain}` to the `prod/klaviyosignups` secret.
3. Redeploy the stack.

## Notes for Agents

- When modifying the Lambda, remember dependencies are split: CDK deps are in root `package.json`, Lambda runtime deps are in `lambda/package.json`.
- The Lambda is **not** a TypeScript Lambda construct with bundling; it is deployed as raw JS via `lambda.Code.fromAsset`. Changes to `lambda/index.js` do not require a `tsc` build, but the CDK app itself is TypeScript and must be compiled before deploying.
- The `test` directory uses `jest` with `testMatch: "**/test/**/*.test.js"`. There is no separate test config file; Jest config is inlined in `package.json`.
- The deploy script (`scripts/deploy.sh`) runs `npm install` in both root and `lambda/` before building and deploying. Use it if you want a one-shot deployment, or use the individual `npm run` commands for incremental work.
- Do not change the DynamoDB `RemovalPolicy.DESTROY` without awareness; this is currently set for development and will delete the table on stack destruction.
