# Zero-Trust FinTech Gateway

A learning project that builds a small FinTech-style backend on AWS with the CDK (TypeScript), following zero-trust principles: every request is authenticated, every component gets least-privilege access, workloads have no internet path, and sensitive data is encrypted with a customer-managed key.

> **Status:** learning project. Several resources use `RemovalPolicy.DESTROY` so the stack can be torn down cleanly. Review those settings before using any of this for real workloads.

## Architecture

```
Client
  |  HTTPS + Cognito access token
  v
HTTP API (API Gateway v2) ---- JWT authorizer (Cognito User Pool) ---- 401 before any Lambda runs
  |                     |
  | GET /me             | POST /upload-url
  v                     v
MeLambda            UploadUrlLambda        both in a PRIVATE_ISOLATED subnet
  |                     |                  (no NAT, no internet gateway route)
  |                     +--> pre-signed S3 PUT URL (uploads/<sub>/<uuid>.<ext>)
  |
  +--> DynamoDB          via gateway endpoint
  +--> SSM Parameter     via interface endpoint
  +--> KMS               via interface endpoint (envelope encryption)
  +--> Secrets Manager   via interface endpoint (opt-in, see below)
```

### What the stack creates

| Area | Resources | Security notes |
| --- | --- | --- |
| Identity | Cognito User Pool and app client | Self sign-up disabled, 12+ character password policy with all character classes, no client secret, `preventUserExistenceErrors`, 15 minute access/ID tokens, 1 day refresh token |
| API | HTTP API with `GET /me` and `POST /upload-url` | Both routes require a valid Cognito access token with scope `aws.cognito.signin.user.admin`. CORS is restricted to a single origin |
| Network | VPC with one private isolated subnet, no NAT | Lambda security group allows only outbound TCP 443. Gateway endpoint for DynamoDB, interface endpoints for SSM and KMS |
| Compute | `MeLambda`, `UploadUrlLambda` (Node.js 22) | Run inside the VPC, 5 second timeout, 256 MB |
| Data | DynamoDB table (`pk` partition key, on-demand) | Lambda has read/write on this table only |
| Secrets and config | Secrets Manager secret `fintech/payment-api-key`, SSM parameter `/fintech/config/max-transfer-amount` | Lambda gets read access to these two items only. Values are cached for 5 minutes via Powertools |
| Encryption | KMS key `alias/fintech-data` with rotation enabled | Lambda can only `GenerateDataKey` and `Decrypt`. Used for envelope encryption and for the upload bucket |
| Uploads | S3 bucket encrypted with the KMS key | Block all public access, TLS enforced, Lambda can only `PutObject` under `uploads/*` |
| Third-party access | Logs bucket, `VendorAnalyticsRole`, `VendorBoundary` managed policy | Vendor role requires an External ID, has a permissions boundary, 1 hour sessions, and read-only access to `transaction-logs/*` |

### Lambda functions

**[lambda/me.ts](lambda/me.ts)** is a diagnostic endpoint that proves each control works from inside the isolated network. It returns:

- `sub` from the verified JWT claims (and rejects with 401 if missing)
- `internetReachable`, which should be `false`
- `dbWriteSuccess`, from a write to DynamoDB through the gateway endpoint
- `secretLoaded` and `secretFetchMs`, from a Secrets Manager fetch (the secret value is never returned)
- `maxTransferAmount`, read from SSM Parameter Store
- `accountMasked`, from an envelope-encryption round trip with the AWS Encryption SDK (key commitment required, encryption context bound to the user's `pk`), returned masked

**[lambda/upload-url.ts](lambda/upload-url.ts)** issues a 5 minute pre-signed S3 PUT URL. Only `application/pdf`, `image/jpeg` and `image/png` are accepted. The server chooses the object key (`uploads/<sub>/<uuid>.<ext>`), never the client, and the `Content-Type` is part of the signature.

## Prerequisites

- Node.js 22 or newer
- An AWS account and credentials configured for the AWS CLI
- The account/region bootstrapped once: `npx cdk bootstrap`

## Getting started

```bash
npm install
npx cdk synth        # emit the CloudFormation template
npx cdk deploy       # deploy to your default account/region
```

`cdk.json` runs `tsc` and then the app through `tsx`, so a TypeScript error will fail `synth` and `deploy`.

### Deploy options (CDK context)

| Context key | Default | Purpose |
| --- | --- | --- |
| `endpoints` | off | Pass `-c endpoints=on` to add the Secrets Manager interface endpoint. Without it, `secretLoaded` in `/me` stays `false` because the isolated subnet cannot reach Secrets Manager |
| `vendorAccount` | your own account | Account ID allowed to assume `VendorAnalyticsRole` |
| `vendorExternalId` | a placeholder UUID in the stack | External ID the vendor must present. Always override this with the value your vendor gives you |

```bash
npx cdk deploy -c endpoints=on -c vendorAccount=111122223333 -c vendorExternalId=<external-id>
```

Interface endpoints are billed per hour while they exist, so destroy the stack when you are done.

### Try it

Self sign-up is disabled, so create a user as an admin, then sign in. The pool and client IDs and the API URL are printed as stack outputs.

```bash
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username you@example.com --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> --username you@example.com --password '<12+ char password>' --permanent

aws cognito-idp initiate-auth --client-id <UserPoolClientId> --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=you@example.com,PASSWORD='<password>'
```

Use the `AccessToken` from the response:

```bash
# Without a token: 401 from API Gateway
curl <ApiUrl>/me

# With a token: diagnostics JSON
curl -H "Authorization: Bearer <AccessToken>" <ApiUrl>/me

# Request an upload URL, then PUT the file with the same Content-Type
curl -X POST -H "Authorization: Bearer <AccessToken>" -H "Content-Type: application/json" \
  -d '{"contentType":"application/pdf"}' <ApiUrl>/upload-url
```

### Stack outputs

`UserPoolIdOutput`, `UserPoolClientIdOutput`, `ApiUrlOutput`, `VendorRoleArnOutput`, `LogsBucketOutput`

## Project layout

```
bin/       CDK app entry point
lib/       The stack definition (zero-trust-fin_tech-gateway-stack.ts)
lambda/    Lambda handlers (me.ts, upload-url.ts)
test/      Jest tests (currently a placeholder)
```

## Commands

| Command | Description |
| --- | --- |
| `npm run build` | Compile TypeScript |
| `npm run watch` | Compile on change |
| `npm test` | Run Jest tests |
| `npx cdk diff` | Compare the deployed stack with local code |
| `npx cdk destroy` | Tear down the stack (the Cognito User Pool is retained) |

## Known limitations

- Set a real origin in `corsPreflight.allowOrigins`. It is still the `https://your-frontend-domain.com` placeholder. CORS only restricts browsers and is not a substitute for the authorizer.
- The encryption demo in `me.ts` encrypts a hardcoded value (`123456789`). It exists to prove the KMS path works, not to store real data.
- `USER_PASSWORD_AUTH` is enabled for CLI testing. Production clients should use SRP only.
- There are no real tests yet: `test/zero-trust-fin_tech-gateway.test.ts` is the CDK template placeholder.
- The DynamoDB table, KMS key and S3 buckets use `DESTROY` (and `autoDeleteObjects`) for easy cleanup. Switch to `RETAIN` and enable point-in-time recovery for anything real.
- Not covered yet: WAF, API throttling, access logging, CloudTrail, and monitoring alarms.
