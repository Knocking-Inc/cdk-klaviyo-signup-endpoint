# Klaviyo Email Signup Endpoint

A serverless email signup endpoint built with AWS CDK that integrates with Klaviyo and provides unique sequence numbers for each subscriber. The system includes comprehensive audit logging, domain-based security, and a unified DynamoDB storage solution.

## Features

- **Email Signup Endpoint**: REST API endpoint for email subscriptions
- **Klaviyo Integration**: Automatically adds emails to your Klaviyo list
- **Sequence Numbers**: Generates unique incremental numbers for each subscriber
- **Security**: API key authentication, domain restrictions, and rate limiting
- **CORS Support**: Configured for web application integration with domain-specific origins
- **Unified DynamoDB Storage**: Single table design for sequence counters and audit records
- **Comprehensive Logging**: All signup attempts logged with success/error status
- **Query Endpoint**: Look up existing signup records by email address
- **Monitoring**: CloudWatch logging and API Gateway metrics
- **Example Implementation**: Complete HTML signup page for testing

## Architecture

- **AWS Lambda**: Node.js 20 runtime for the signup logic
- **API Gateway**: REST API with rate limiting and API key authentication
- **DynamoDB**: Unified table storing sequence counters and signup records
- **CloudWatch**: Logging and monitoring
- **Secrets Manager**: Secure storage of Klaviyo API credentials per domain

## Prerequisites

- AWS CLI configured with appropriate permissions
- Node.js 18+ installed
- CDK CLI installed (`npm install -g aws-cdk`)
- Klaviyo account with API key and list ID

## Setup Instructions

### 1. Install Dependencies

```bash
# Install CDK project dependencies
npm install

# Install Lambda function dependencies
cd lambda
npm install
cd ..
```

### 2. Configure Environment Variables

Edit the `lib/klaviyo-signup-stack.ts` file and update the following environment variables in the Lambda function:

```typescript
environment: {
  SEQUENCE_TABLE_NAME: signupTable.tableName,
  SECRETS_NAME: 'prod/klaviyosignups',
  API_KEY: 'your-secure-api-key-here', // Replace with a secure API key
  ALLOWED_DOMAINS: 'moviexclusives.com,localhost', // Comma-separated list of allowed domains
},
```

**Important Security Note**: The `localhost` domain should only be used for development/testing. Remove it from `ALLOWED_DOMAINS` for production deployments.

### 3. Configure AWS Secrets Manager

Ensure your `prod/klaviyosignups` secret exists in AWS Secrets Manager with the following structure:

```json
{
  "KlaviyoPrivateKey_moviexclusives.com": "your-klaviyo-api-key",
  "KlaviyoListId_moviexclusives.com": "your-klaviyo-list-id",
  "KlavioSiteID_moviexclusives.com": "your-klaviyo-site-id",
  "KlaviyoPrivateKey_anothersite.com": "another-klaviyo-api-key",
  "KlaviyoListId_anothersite.com": "another-klaviyo-list-id",
  "KlavioSiteID_anothersite.com": "another-klaviyo-site-id"
}
```

The secret keys follow the pattern: `{SecretName}_{domain}` where `domain` is the signup domain (e.g., `moviexclusives.com`).

### 4. Deploy the Stack

```bash
# Build the project
npm run build

# Deploy to AWS
npm run deploy
```

### 5. Get API Key

After deployment, retrieve your API key from the AWS Console:
1. Go to API Gateway in AWS Console
2. Navigate to API Keys
3. Find the key with name `klaviyo-signup-api-key`
4. Copy the API key value

## Usage

### API Endpoints

#### Signup Endpoint

**URL**: `https://[api-id].execute-api.[region].amazonaws.com/prod/signup`

**Method**: POST

**Headers**:
```
Content-Type: application/json
X-API-Key: your-api-key-here
```

**Request Body**:
```json
{
  "email": "user@example.com",
  "domain": "moviexclusives.com"
}
```

**Success Response** (200) - New Subscription:
```json
{
  "success": true,
  "message": "Email successfully subscribed",
  "sequenceNumber": 42,
  "email": "user@example.com",
  "domain": "moviexclusives.com",
  "alreadySubscribed": false
}
```

**Success Response** (200) - Already Subscribed:
```json
{
  "success": true,
  "message": "Email already subscribed",
  "sequenceNumber": 42,
  "email": "user@example.com",
  "domain": "moviexclusives.com",
  "alreadySubscribed": true
}
```

#### Query Endpoint

**URL**: `https://[api-id].execute-api.[region].amazonaws.com/prod/query`

**Method**: POST

**Headers**:
```
Content-Type: application/json
```

**Query Parameters** (optional):
- `retry=true` or `retry=1`: Enable retry logic for eventual consistency

**Request Body**:
```json
{
  "email": "user@example.com",
  "domain": "moviexclusives.com"
}
```

**Success Response** (200) - Record Found:
```json
{
  "success": true,
  "found": true,
  "email": "user@example.com",
  "domain": "moviexclusives.com",
  "sequenceNumber": 42,
  "status": "success",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "emailHash": "sha256-hash-of-email",
  "attempts": 1
}
```

**Success Response** (200) - No Record Found (without retry):
```json
{
  "success": true,
  "found": false,
  "email": "user@example.com",
  "message": "No signup record found for this email",
  "attempts": 1,
  "retried": false
}
```

**Success Response** (200) - No Record Found (with retry):
```json
{
  "success": true,
  "found": false,
  "email": "user@example.com",
  "message": "No signup record found for this email",
  "attempts": 5,
  "retried": true
}
```

**Retry Behavior**:
- Without `retry` parameter: Returns immediately after first database query
- With `retry=true` or `retry=1`: If no record found, retries every second for up to 4 seconds (5 total attempts)
- Returns as soon as a record is found or after 4 seconds of retrying
- Useful for handling DynamoDB eventual consistency delays

**Error Responses**:
- `400`: Invalid email format, missing email, missing domain, or invalid domain
- `403`: Domain not allowed
- `405`: Wrong HTTP method
- `429`: Rate limit exceeded
- `500`: Internal server error

### Frontend Integration Example

```javascript
async function signupEmail(email, domain) {
  try {
    const response = await fetch('https://[api-id].execute-api.[region].amazonaws.com/prod/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'your-api-key-here'
      },
      body: JSON.stringify({ email, domain })
    });

    const result = await response.json();
    
    if (response.ok) {
      console.log(`Success! You are subscriber #${result.sequenceNumber} for ${result.domain}`);
      return result;
    } else {
      throw new Error(result.message);
    }
  } catch (error) {
    console.error('Signup failed:', error.message);
    throw error;
  }
}
```

### Example Signup Page

A complete HTML signup page is provided in `examples/signup-page.html` for testing and demonstration purposes. The page includes:

- Modern, responsive design
- Real-time form validation
- Error handling and user feedback
- Sequence number display
- Security warnings for localhost usage

To use the example page:
1. Update the API endpoint and key in the HTML file
2. Set the domain to match your `ALLOWED_DOMAINS` configuration
3. Serve the file via a local web server (e.g., `python -m http.server 8000`)

### Query Retry Example

A Node.js example demonstrating the query endpoint retry functionality is provided in `examples/query-retry-example.js`. This example shows:

- How to use the `retry=true` parameter
- Different usage scenarios for retry vs. immediate queries
- Handling DynamoDB eventual consistency delays

To run the example:
```bash
cd examples
npm install axios
node query-retry-example.js
```

## Security Features

### Domain Restrictions
- Only pre-configured domains are allowed for signups
- CORS headers are dynamically set based on the signup domain
- Production domains automatically use HTTPS origins

### Rate Limiting
- **Rate Limit**: 100 requests per second
- **Burst Limit**: 200 requests
- **Daily Quota**: 500,000 requests per day

### Authentication
- API key required for signup endpoint only
- Query endpoint is publicly accessible (no API key required)
- Domain-specific CORS configuration

### Input Validation
- Email format validation
- Domain format validation
- JSON schema validation
- Request method validation

### Data Protection
- Email addresses stored as SHA-256 hashes only (not in plain text)
- Email hashing provides data integrity and privacy protection
- Query endpoint returns email hash for verification without exposing plain text

## Monitoring and Logging

### CloudWatch Logs
- Lambda function logs with 1-week retention
- API Gateway access logs
- Error tracking and debugging

### Signup Records Tracking
The system stores all signup attempts in a unified DynamoDB table for monitoring and auditing:

**Table**: `klaviyo-signup`

**Record Structure**:
```json
{
  "id": "sha256-hash-of-email",
  "type": "record",
  "domain": "moviexclusives.com",
  "sequence_number": 42,
  "status": "success|error",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "created_at": "2024-01-15T10:30:00.000Z",
  "error_message": "Optional error details for failed signups"
}
```

**Counter Structure**:
```json
{
  "id": "signup-counter-moviexclusives.com",
  "type": "counter",
  "count": 42
}
```

**Global Secondary Indexes**:
- `DomainStatusIndex`: Query by domain and status
- `StatusTimestampIndex`: Query by status and timestamp (most recent first)

### Querying Signup Records

Use the provided script to query signup records:

```bash
# Query by domain
node scripts/query-signup-records.js domain moviexclusives.com

# Query by domain and status
node scripts/query-signup-records.js domain moviexclusives.com success

# Query recent error records
node scripts/query-signup-records.js status error 10

# Query recent success records
node scripts/query-signup-records.js status success 20

# Show recent records (all statuses)
node scripts/query-signup-records.js recent 50

# Query by email address
node scripts/query-signup-records.js email user@example.com
```

### Metrics
- API Gateway metrics available in CloudWatch
- DynamoDB metrics for table performance
- Signup success/error rates via DynamoDB queries

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SEQUENCE_TABLE_NAME` | DynamoDB table name for storing records and counters | Yes |
| `SECRETS_NAME` | AWS Secrets Manager secret name containing Klaviyo credentials | Yes |
| `API_KEY` | Custom API key for authentication | Yes |
| `ALLOWED_DOMAINS` | Comma-separated list of allowed signup domains | Yes |

### Secrets Manager Configuration

The Lambda function retrieves domain-specific Klaviyo credentials from AWS Secrets Manager. Each domain requires three secret keys:

| Secret Key Pattern | Description | Example |
|-------------------|-------------|---------|
| `KlaviyoPrivateKey_{domain}` | Klaviyo API key for the domain | `KlaviyoPrivateKey_moviexclusives.com` |
| `KlaviyoListId_{domain}` | Klaviyo list ID for the domain | `KlaviyoListId_moviexclusives.com` |
| `KlavioSiteID_{domain}` | Klaviyo site ID for the domain | `KlavioSiteID_moviexclusives.com` |

### DynamoDB Table Design

The system uses a single DynamoDB table for both sequence counters and signup records:

#### Unified Table (`klaviyo-signup`)
- **Partition Key**: `id` (String)
- **Sort Key**: `type` (String)
- **Item Types**:
  - **Counters**: `id` = `signup-counter-{domain}`, `type` = `counter`, `count` = sequence number
  - **Records**: `id` = `sha256-hash-of-email`, `type` = `record`, plus domain, sequence_number, status, timestamp, etc.
- **Global Secondary Indexes**:
  - `DomainStatusIndex`: Partition key `domain`, Sort key `status` (for records only)
  - `StatusTimestampIndex`: Partition key `status`, Sort key `timestamp` (for records only)
- **Purpose**: Unified storage for sequence counters and audit trail
- **Security**: Email addresses are stored as SHA-256 hashes only, not in plain text

## Development

### Testing

Run the test suite:

```bash
npm test
```

### Local Development

For local testing, ensure `localhost` is in your `ALLOWED_DOMAINS`:

```typescript
ALLOWED_DOMAINS: 'moviexclusives.com,localhost'
```

**Security Warning**: Remove `localhost` from production deployments.

### Deployment Script

Use the provided deployment script for automated deployments:

```bash
./scripts/deploy.sh
```

## Troubleshooting

### Common Issues

1. **Domain Not Allowed Error**: Ensure the domain is in the `ALLOWED_DOMAINS` environment variable
2. **Missing Secrets**: Verify all required Klaviyo secrets exist in AWS Secrets Manager
3. **CORS Issues**: Check that the signup domain matches the allowed domains
4. **Rate Limiting**: Monitor API Gateway usage and adjust limits if needed

### Debugging

- Check CloudWatch logs for Lambda function errors
- Use the query script to verify signup records
- Monitor DynamoDB metrics for performance issues
- Review API Gateway access logs for request patterns

## License

This project is licensed under the MIT License.