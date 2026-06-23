const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const axios = require('axios');
const crypto = require('crypto');

const dynamoClient = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient();

// Environment variables
const SEQUENCE_TABLE_NAME = process.env.SEQUENCE_TABLE_NAME;
const SECRETS_NAME = process.env.SECRETS_NAME;
const API_KEY = process.env.API_KEY;

// Parse allowed domains from environment variable
const ALLOWED_DOMAINS = process.env.ALLOWED_DOMAINS?.split(',') || [];

function isAllowedDomain(domain) {
  return ALLOWED_DOMAINS.includes(domain);
}

// Cache for secrets (in-memory cache that persists across invocations)
let secretsCache = {};
let cacheExpiry = {};
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

// Helper function to get CORS headers for a specific domain
function getCorsHeaders(domain, actualOrigin = null) {

  // Allow the actual origin if it's a development/testing domain
  if (actualOrigin.includes('localhost') || 
      actualOrigin.includes('127.0.0.1') || 
      actualOrigin.includes('framercanvas.com') ||
      actualOrigin.includes('framer.app')) {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,X-API-Key',
      'Access-Control-Allow-Methods': 'POST,OPTIONS,GET',
      'Access-Control-Max-Age': '86400',
    };
  } 
  
  // For production domains, check if domain is allowed
  if (!isAllowedDomain(domain)) {
    return {};
  }
  
  // Production domains use https:// prefix
  const allowOrigin = `https://${domain}`;
  
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type,X-API-Key',
    'Access-Control-Allow-Methods': 'POST,OPTIONS,GET',
    'Access-Control-Max-Age': '86400',
  };
}

// Helper function to get secrets from AWS Secrets Manager with caching
async function getSecrets(domain) {
  const now = Date.now();
  
  // Return cached secrets if still valid
  if (secretsCache[domain] && now < cacheExpiry[domain]) {
    console.log('Using cached secrets for domain', { domain, cacheAge: Math.floor((now - (cacheExpiry[domain] - CACHE_DURATION)) / 1000) + 's' });
    return secretsCache[domain];
  }

  try {
    console.log('Retrieving secrets from AWS Secrets Manager', { domain, secretName: SECRETS_NAME });
    const command = new GetSecretValueCommand({
      SecretId: SECRETS_NAME,
    });
    
    const response = await secretsClient.send(command);
    const secrets = JSON.parse(response.SecretString);
    
    // Validate that all required secrets exist for this domain
    const requiredSecrets = [
      `KlaviyoPrivateKey_${domain}`,
      `KlaviyoListId_${domain}`,
      `KlavioSiteID_${domain}`
    ];
    
    const missingSecrets = requiredSecrets.filter(secretKey => !secrets[secretKey]);
    if (missingSecrets.length > 0) {
      console.log('Missing required secrets for domain', { domain, missingSecrets, availableSecrets: Object.keys(secrets) });
      throw new Error(`Missing required secrets for domain ${domain}: ${missingSecrets.join(', ')}`);
    }
    
    // Cache the secrets for this domain
    secretsCache[domain] = {
      klaviyoApiKey: secrets[`KlaviyoPrivateKey_${domain}`],
      klaviyoListId: secrets[`KlaviyoListId_${domain}`],
      klaviyoSiteId: secrets[`KlavioSiteID_${domain}`]
    };
    
    // Set cache expiry for this domain
    cacheExpiry[domain] = now + CACHE_DURATION;
    
    console.log('Secrets retrieved and cached successfully for domain', { 
      domain, 
      hasApiKey: !!secretsCache[domain].klaviyoApiKey,
      hasListId: !!secretsCache[domain].klaviyoListId,
      hasSiteId: !!secretsCache[domain].klaviyoSiteId,
      cacheExpiry: new Date(cacheExpiry[domain]).toISOString()
    });
    return secretsCache[domain];
  } catch (error) {
    console.log('Error retrieving secrets for domain', { 
      domain, 
      errorType: error.constructor.name,
      errorMessage: error.message,
      secretName: SECRETS_NAME 
    });
    throw new Error(`Failed to retrieve secrets for domain: ${domain}`);
  }
}

// Helper function to generate response
function createResponse(statusCode, body, domain, headers = {}, actualOrigin = null) {
  return {
    statusCode,
    headers: { ...getCorsHeaders(domain, actualOrigin), ...headers },
    body: JSON.stringify(body),
  };
}

// Helper function to validate email format
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Helper function to validate domain format
function isValidDomain(domain) {
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return domainRegex.test(domain);
}

// Helper function to get and increment sequence number
async function getNextSequenceNumber(domain) {
  try {
    const counterId = `signup-counter-${domain}`;
    console.log('Updating DynamoDB counter', { tableName: SEQUENCE_TABLE_NAME, counterId });
    
    const result = await docClient.send(new UpdateCommand({
      TableName: SEQUENCE_TABLE_NAME,
      Key: { 
        id: counterId,
        type: 'counter'
      },
      UpdateExpression: 'SET #count = if_not_exists(#count, :start) + :incr',
      ExpressionAttributeNames: {
        '#count': 'count'
      },
      ExpressionAttributeValues: {
        ':start': 23420,
        ':incr': 1
      },
      ReturnValues: 'UPDATED_NEW'
    }));
    
    const sequenceNumber = result.Attributes.count;
    console.log('DynamoDB counter updated successfully', { domain, counterId, sequenceNumber });
    return sequenceNumber;
  } catch (error) {
    console.log('DynamoDB counter update failed', { 
      domain, 
      errorType: error.constructor.name,
      errorMessage: error.message,
      tableName: SEQUENCE_TABLE_NAME 
    });
    const enhancedError = new Error('Failed to generate sequence number');
    enhancedError.domain = domain;
    throw enhancedError;
  }
}

// Helper function to store signup record
async function storeSignupRecord(email, sequenceNumber, domain, status, errorMessage = null) {
  try {
    const timestamp = new Date().toISOString();
    const emailHash = crypto.createHash('sha256').update(email.toLowerCase() + domain.toLowerCase()).digest('hex');
    
    const record = {
      id: emailHash,
      type: 'record',
      domain: domain,
      sequence_number: sequenceNumber,
      status: status,
      timestamp: timestamp,
      created_at: timestamp
    };

    // Add error message if status is error
    if (status === 'error' && errorMessage) {
      record.error_message = errorMessage;
    }

    console.log('Storing signup record', { 
      tableName: SEQUENCE_TABLE_NAME, 
      email: email.substring(0, 3) + '***',
      emailHash: emailHash.substring(0, 8) + '***',
      domain,
      sequenceNumber,
      status 
    });

    await docClient.send(new PutCommand({
      TableName: SEQUENCE_TABLE_NAME,
      Item: record
    }));

    console.log('Signup record stored successfully', { 
      domain, 
      sequenceNumber,
      email: email.substring(0, 3) + '***',
      emailHash: emailHash.substring(0, 8) + '***',
      status 
    });
  } catch (error) {
    console.log('Failed to store signup record', { 
      domain, 
      errorType: error.constructor.name,
      errorMessage: error.message,
      tableName: SEQUENCE_TABLE_NAME,
      sequenceNumber,
      email: email.substring(0, 3) + '***'
    });
    // Don't throw error here - we don't want to fail the signup if record storage fails
  }
}

// Helper function to add email to Klaviyo list
async function addToKlaviyoList(email, sequenceNumber, domain) {
  try {
    console.log('Retrieving Klaviyo secrets for domain', { domain });
    const secrets = await getSecrets(domain);
    console.log('Klaviyo secrets retrieved', { domain, hasApiKey: !!secrets.klaviyoApiKey, hasListId: !!secrets.klaviyoListId });
    
    // Use bulk subscription job to set subscription status and add to list
    const bulkJobPayload = {
      data: {
        type: "profile-subscription-bulk-create-job",
        attributes: {
          profiles: {
            data: [
              {
                type: "profile",
                attributes: {
                  subscriptions: {
                    email: {
                      marketing: {
                        consent: "SUBSCRIBED"
                      }
                    }
                  },
                  email
                }
              }
            ]
          },
          historical_import: false,
          custom_source: `Website Signup - Sequence: ${sequenceNumber}`
        },
        relationships: {
          list: {
            data: {
              type: "list",
              id: secrets.klaviyoListId
            }
          }
        }
      }
    };

    console.log('Setting subscription and adding to list', {
      domain,
      url: 'https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs',
      listId: secrets.klaviyoListId
    });

    const response = await axios.post('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs', bulkJobPayload, {
      headers: {
        'Authorization': `Klaviyo-API-Key ${secrets.klaviyoApiKey}`,
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json',
        'revision': '2025-04-15'
      }
    });

    console.log('Klaviyo API call successful', { 
      domain, 
      statusCode: response.status, 
      sequenceNumber,
      email: email.substring(0, 3) + '***',
      responseData: response.data
    });
    return true;
  } catch (error) {
    console.log('Klaviyo API call failed', { 
      domain, 
      errorType: error.constructor.name,
      errorMessage: error.message,
      responseStatus: error.response?.status,
      responseStatusText: error.response?.statusText,
      responseHeaders: error.response?.headers,
      responseData: error.response?.data,
      requestUrl: error.config?.url,
      requestMethod: error.config?.method,
      requestHeaders: error.config?.headers,
      requestData: error.config?.data,
      sequenceNumber,
      email: email.substring(0, 3) + '***'
    });
    
    // Log detailed error information for debugging
    if (error.response?.data?.errors) {
      console.log('Klaviyo API detailed errors', {
        domain,
        errors: JSON.stringify(error.response.data.errors, null, 2),
        sequenceNumber,
        email: email.substring(0, 3) + '***'
      });
    }
    
    // Add sequence number to error context for record storage
    const enhancedError = new Error('Failed to add email to Klaviyo list');
    enhancedError.sequenceNumber = sequenceNumber;
    enhancedError.domain = domain;
    throw enhancedError;
  }
}

// Helper function to validate request
function validateRequest(event) {
  // Validate API key
  const apiKey = event.headers['x-api-key'] || event.headers['X-API-Key'];
  
  if (!apiKey || apiKey !== API_KEY) {
    const origin = event.headers.origin || event.headers.Origin || '';
    const domain = origin.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'unknown';
    console.log('API key validation failed', { 
      hasApiKey: !!apiKey, 
      apiKeyMatches: apiKey === API_KEY,
      domain 
    });
    throw {
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid API key',
      domain
    };
  }

  console.log('API key validation passed');

  // Validate request method
  if (event.httpMethod !== 'POST') {
    const origin = event.headers.origin || event.headers.Origin || '';
    const domain = origin.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'unknown';
    console.log('Invalid HTTP method', { method: event.httpMethod, domain });
    throw {
      statusCode: 405,
      error: 'Method Not Allowed',
      message: 'Only POST method is allowed',
      domain
    };
  }

  // Parse and validate request body
  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
    console.log('Request body parsed successfully', { 
      hasEmail: !!requestBody.email, 
      hasDomain: !!requestBody.domain,
      domain: requestBody.domain 
    });
  } catch (error) {
    const origin = event.headers.origin || event.headers.Origin || '';
    const domain = origin.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'unknown';
    console.log('JSON parsing failed', { error: error.message, domain });
    throw {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
      domain
    };
  }

  const { email, domain } = requestBody;

  if (!email || !isValidEmail(email)) {
    console.log('Email validation failed', { email: email ? email.substring(0, 3) + '***' : 'missing', domain });
    throw {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Valid email address is required',
      domain: domain || 'unknown'
    };
  }

  if (!domain || !isValidDomain(domain)) {
    console.log('Domain validation failed', { domain: domain || 'missing' });
    throw {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Valid domain is required',
      domain: domain || 'unknown'
    };
  }

  if (!isAllowedDomain(domain)) {
    console.log('Domain not allowed', { domain, allowedDomains: ALLOWED_DOMAINS });
    throw {
      statusCode: 403,
      error: 'Forbidden',
      message: 'Domain is not allowed',
      domain: domain || 'unknown'
    };
  }

  console.log('All validations passed', { email: email.substring(0, 3) + '***', domain });
  return { email, domain };
}

// Helper function to handle errors
function handleError(error, event, actualOrigin) {
  console.log('Handling error', { 
    errorType: error.constructor.name,
    errorMessage: error.message,
    hasStatusCode: !!error.statusCode,
    statusCode: error.statusCode || 'none'
  });
  
  // If it's a validation error with status code, return it directly
  if (error.statusCode) {
    console.log('Returning validation error response', { 
      statusCode: error.statusCode, 
      error: error.error, 
      domain: error.domain 
    });
    return createResponse(error.statusCode, {
      error: error.error,
      message: error.message
    }, error.domain, {}, actualOrigin);
  }
  
  // Get domain for internal errors
  let domain = 'unknown';
  try {
    const requestBody = JSON.parse(event.body);
    domain = requestBody.domain || domain;
  } catch (e) {
    const origin = event.headers.origin || event.headers.Origin || '';
    domain = origin.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'unknown';
  }
  
  // Map error types to appropriate responses
  if (error.message.includes('sequence number')) {
    console.log('DynamoDB error response', { domain, errorMessage: error.message });
    return createResponse(500, {
      error: 'Internal Server Error',
      message: 'Failed to process signup request'
    }, domain, {}, actualOrigin);
  } else if (error.message.includes('Klaviyo')) {
    console.log('Klaviyo error response', { domain, errorMessage: error.message });
    return createResponse(500, {
      error: 'Internal Server Error',
      message: 'Failed to add email to mailing list'
    }, domain, {}, actualOrigin);
  } else if (error.message.includes('secrets')) {
    console.log('Secrets error response', { domain, errorMessage: error.message });
    return createResponse(500, {
      error: 'Internal Server Error',
      message: 'Failed to retrieve configuration'
    }, domain, {}, actualOrigin);
  } else {
    console.log('Generic error response', { domain, errorMessage: error.message });
    return createResponse(500, {
      error: 'Internal Server Error',
      message: 'An unexpected error occurred'
    }, domain, {}, actualOrigin);
  }
}

// Main handler function
exports.handler = async (event) => {
  console.log('Lambda invoked', {
    method: event.httpMethod,
    resource: event.resource,
    path: event.path,
    origin: event.headers.origin || event.headers.Origin || 'none',
    hasApiKey: !!(event.headers['x-api-key'] || event.headers['X-API-Key']),
    bodyLength: event.body ? event.body.length : 0
  });

  // Extract the actual origin for CORS
  const actualOrigin = event.headers.origin || event.headers.Origin || '';

  // Handle CORS preflight requests
  if (event.httpMethod === 'OPTIONS') {
    
    console.log('CORS preflight request', { actualOrigin, allowOrigin });
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-API-Key',
        'Access-Control-Allow-Methods': 'POST,OPTIONS,GET',
        'Access-Control-Max-Age': '86400',
      },
      body: JSON.stringify({}),
    };
  }

  // Route to appropriate handler based on resource path
  if (event.resource === '/query' || event.path === '/query') {
    return await handleQueryRequest(event, actualOrigin);
  } else {
    return await handleSignupRequest(event, actualOrigin);
  }
};

// Handler for signup requests
async function handleSignupRequest(event, actualOrigin) {
  try {
    // Validate request and extract email/domain
    const { email, domain } = validateRequest(event);
    console.log('Request validated', { email: email.substring(0, 3) + '***', domain });

    // Check if email already exists for this domain
    console.log('Checking if email already exists', { email: email.substring(0, 3) + '***', domain });
    const existingRecord = await getSignupRecordByEmail(email, domain);
    
    if (existingRecord && existingRecord.status === 'success') {
      console.log('Email already exists with success status, returning existing record', { 
        email: email.substring(0, 3) + '***', 
        domain, 
        sequenceNumber: existingRecord.sequence_number,
        status: existingRecord.status
      });
      
      return createResponse(200, {
        success: true,
        message: 'Email already subscribed',
        sequenceNumber: existingRecord.sequence_number,
        email: email,
        domain: domain,
        alreadySubscribed: true
      }, domain, {}, actualOrigin);
    }

    // Email doesn't exist or has non-success status, proceed with new signup
    if (existingRecord) {
      console.log('Email exists but with non-success status, proceeding with new signup', { 
        email: email.substring(0, 3) + '***', 
        domain, 
        existingStatus: existingRecord.status
      });
    } else {
      console.log('Email not found, proceeding with new signup', { email: email.substring(0, 3) + '***', domain });
    }

    // Main business logic - the common path
    console.log('Getting sequence number for domain', { domain });
    const sequenceNumber = await getNextSequenceNumber(domain);
    console.log('Sequence number generated', { domain, sequenceNumber });

    console.log('Adding email to Klaviyo list', { email: email.substring(0, 3) + '***', domain });
    await addToKlaviyoList(email, sequenceNumber, domain);
    console.log('Email successfully added to Klaviyo', { email: email.substring(0, 3) + '***', domain, sequenceNumber });

    // Store successful signup record
    await storeSignupRecord(email, sequenceNumber, domain, 'success');

    // Return success response
    return createResponse(200, {
      success: true,
      message: 'Email successfully subscribed',
      sequenceNumber: sequenceNumber,
      email: email,
      domain: domain,
      alreadySubscribed: false
    }, domain, {}, actualOrigin);

  } catch (error) {
    console.log('Error in signup handler', { 
      errorType: error.constructor.name,
      errorMessage: error.message,
      hasStatusCode: !!error.statusCode,
      domain: error.domain || 'unknown'
    });

    // Try to store error record if we have email and domain
    try {
      const requestBody = JSON.parse(event.body);
      const email = requestBody.email;
      const domain = requestBody.domain || error.domain || 'unknown';
      
      // If we have a sequence number from the error context, use it
      let sequenceNumber = null;
      if (error.sequenceNumber) {
        sequenceNumber = error.sequenceNumber;
      }
      
      if (email && domain) {
        await storeSignupRecord(email, sequenceNumber, domain, 'error', error.message);
      }
    } catch (storeError) {
      console.log('Failed to store error record', { 
        storeError: storeError.message,
        originalError: error.message 
      });
    }

    return handleError(error, event, actualOrigin);
  }
}

// Handler for query requests
async function handleQueryRequest(event, actualOrigin) {
  try {
    // Parse and validate request body
    let requestBody;
    try {
      requestBody = JSON.parse(event.body);
      console.log('Query request body parsed', { 
        hasEmail: !!requestBody.email,
        hasDomain: !!requestBody.domain
      });
    } catch (error) {
      console.log('JSON parsing failed for query', { error: error.message });
      return createResponse(400, {
        error: 'Bad Request',
        message: 'Invalid JSON in request body'
      }, 'unknown', {}, actualOrigin);
    }

    const { email, domain } = requestBody;

    if (!email || !isValidEmail(email)) {
      console.log('Email validation failed for query', { email: email ? email.substring(0, 3) + '***' : 'missing' });
      return createResponse(400, {
        error: 'Bad Request',
        message: 'Valid email address is required'
      }, 'unknown', {}, actualOrigin);
    }

    if (!domain || !isValidDomain(domain)) {
      console.log('Domain validation failed for query', { domain: domain || 'missing' });
      return createResponse(400, {
        error: 'Bad Request',
        message: 'Valid domain is required'
      }, 'unknown', {}, actualOrigin);
    }

    // Check if retry parameter is present in query string
    const queryParams = event.queryStringParameters || {};
    const shouldRetry = queryParams.retry === 'true' || queryParams.retry === '1';
    
    console.log('Query request parameters', { 
      email: email.substring(0, 3) + '***',
      shouldRetry,
      queryParams
    });

    // Query the signup record with optional retry logic
    let record = null;
    let attempts = 0;
    const maxAttempts = shouldRetry ? 5 : 1; // 1 initial + 5 retries = 6 total attempts
    const retryDelay = 1000; // 1 second

    for (attempts = 0; attempts < maxAttempts; attempts++) {
      record = await getSignupRecordByEmail(email, domain);
      
      if (record) {
        console.log('Signup record found on attempt', { 
          attempts, 
          email: email.substring(0, 3) + '***',
          shouldRetry 
        });
        break;
      }
      
      if (attempts < maxAttempts) {
        console.log('No record found on attempt, waiting before retry', { 
          attempts, 
          maxAttempts,
          email: email.substring(0, 3) + '***',
          retryDelay 
        });
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    if (record) {
      // Return the record (excluding sensitive fields)
      return createResponse(200, {
        success: true,
        found: true,
        email: email,
        domain: record.domain,
        sequenceNumber: record.sequence_number,
        status: record.status,
        timestamp: record.timestamp,
        emailHash: record.email_hash,
        attempts: attempts
      }, record.domain, {}, actualOrigin);
    } else {
      return createResponse(200, {
        success: true,
        found: false,
        email: email,
        message: 'No signup record found for this email',
        attempts: attempts,
        retried: shouldRetry
      }, 'unknown', {}, actualOrigin);
    }

  } catch (error) {
    console.log('Error in query handler', { 
      errorType: error.constructor.name,
      errorMessage: error.message
    });
    
    return createResponse(500, {
      error: 'Internal Server Error',
      message: 'Failed to query signup record'
    }, 'unknown', {}, actualOrigin);
  }
}

// Helper function to query signup record by email
async function getSignupRecordByEmail(email, domain) {
  try {
    const emailHash = crypto.createHash('sha256').update(email.toLowerCase() + domain.toLowerCase()).digest('hex'); 
    
    console.log('Querying signup record by email', { 
      tableName: SEQUENCE_TABLE_NAME, 
      email: email.substring(0, 3) + '***',
      domain: domain,
      emailHash: emailHash.substring(0, 8) + '***'
    });

    const result = await docClient.send(new GetCommand({
      TableName: SEQUENCE_TABLE_NAME,
      Key: {
        id: emailHash,
        type: 'record'
      }
    }));

    if (result.Item) {
      console.log('Signup record found', { 
        email: email.substring(0, 3) + '***',
        emailHash: emailHash.substring(0, 8) + '***',
        domain: result.Item.domain,
        status: result.Item.status,
        sequenceNumber: result.Item.sequence_number
      });
      // Add the email hash to the result for the response
      result.Item.email_hash = emailHash;
      return result.Item;
    } else {
      console.log('No signup record found for email', { 
        email: email.substring(0, 3) + '***',
        emailHash: emailHash.substring(0, 8) + '***',
        domain: domain
      });
      return null;
    }
  } catch (error) {
    console.log('Failed to query signup record by email', { 
      errorType: error.constructor.name,
      errorMessage: error.message,
      tableName: SEQUENCE_TABLE_NAME,
      email: email.substring(0, 3) + '***',
      domain: domain
    });
    throw new Error('Failed to query signup record');
  }
} 