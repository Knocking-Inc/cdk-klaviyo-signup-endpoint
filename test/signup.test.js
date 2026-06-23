const { handler } = require('../lambda/index.js');

// Mock environment variables
process.env.SEQUENCE_TABLE_NAME = 'test-table';
process.env.SECRETS_NAME = 'test-secrets';
process.env.API_KEY = 'test-api-key';
process.env.ALLOWED_DOMAINS = 'moviexclusives.com,test.com';

// Mock AWS SDK
const mockDynamoDB = {
  send: jest.fn()
};

const mockSecretsManager = {
  send: jest.fn()
};

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => mockDynamoDB)
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => mockDynamoDB)
  },
  UpdateCommand: jest.fn(),
  PutCommand: jest.fn(),
  GetCommand: jest.fn()
}));

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => mockSecretsManager),
  GetSecretValueCommand: jest.fn()
}));

// Mock axios
const mockAxios = {
  post: jest.fn()
};
jest.mock('axios', () => mockAxios);

describe('Signup Lambda Function', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock DynamoDB responses
    mockDynamoDB.send.mockImplementation((command) => {
      // Mock sequence number update
      if (command.constructor.name === 'UpdateCommand') {
        return Promise.resolve({
          Attributes: { count: 42 }
        });
      } 
      // Mock record storage
      else if (command.constructor.name === 'PutCommand') {
        return Promise.resolve({});
      } 
      // Mock record retrieval - return null for "not found" scenarios
      else if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: null });
      }
      return Promise.resolve({});
    });

    // Mock Secrets Manager response
    mockSecretsManager.send.mockResolvedValue({
      SecretString: JSON.stringify({
        KlaviyoPrivateKey_moviexclusives: 'test-klaviyo-key',
        KlaviyoListId_moviexclusives: 'test-list-id',
        KlavioSiteID_moviexclusives: 'test-site-id',
        KlaviyoPrivateKey_test: 'test-klaviyo-key',
        KlaviyoListId_test: 'test-list-id',
        KlavioSiteID_test: 'test-site-id'
      })
    });

    // Mock axios response for Klaviyo API
    mockAxios.post.mockResolvedValue({
      status: 200,
      data: {
        data: {
          id: 'test-profile-id'
        }
      }
    });
  });

  test('should handle CORS preflight request', async () => {
    const event = {
      httpMethod: 'OPTIONS',
      headers: {
        origin: 'https://moviexclusives.com'
      }
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(result.headers['Access-Control-Allow-Origin']).toBe('https://moviexclusives.com');
  });

  test('should reject invalid API key', async () => {
    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'wrong-key',
        origin: 'https://test.com'
      },
      body: JSON.stringify({ email: 'test@example.com', domain: 'test.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error).toBe('Unauthorized');
  });

  test('should reject invalid email format', async () => {
    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'invalid-email', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Bad Request');
  });

  test('should reject missing email', async () => {
    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Bad Request');
  });

  test('should reject missing domain', async () => {
    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'test@example.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Bad Request');
  });

  test('should reject invalid domain format', async () => {
    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'test@example.com', domain: 'invalid-domain!' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Bad Request');
  });

  test('should reject wrong HTTP method', async () => {
    const event = {
      httpMethod: 'GET',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://test.com'
      }
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(405);
    expect(JSON.parse(result.body).error).toBe('Method Not Allowed');
  });

  test('should reject forbidden domain', async () => {
    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://notallowed.com'
      },
      body: JSON.stringify({ email: 'test@example.com', domain: 'notallowed.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error).toBe('Forbidden');
  });

  test('should accept allowed domain', async () => {
    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'test@example.com', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    // Should not return 403 (Forbidden) for allowed domain
    expect(result.statusCode).not.toBe(403);
  });

  test('should handle query request with valid email', async () => {
    const event = {
      httpMethod: 'POST',
      resource: '/query',
      headers: {
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'test@example.com', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    // Should return 200 for valid query request
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.found).toBeDefined();
  });

  test('should reject query request with invalid email', async () => {
    const event = {
      httpMethod: 'POST',
      resource: '/query',
      headers: {
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'invalid-email', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Bad Request');
  });

  test('should accept query request without API key', async () => {
    const event = {
      httpMethod: 'POST',
      resource: '/query',
      headers: {
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'test@example.com', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    // Should return 200 for valid query request without API key
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.found).toBeDefined();
  });

  test('should reject query request with missing email', async () => {
    const event = {
      httpMethod: 'POST',
      resource: '/query',
      headers: {
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Bad Request');
  });

  test('should reject query request with missing domain', async () => {
    const event = {
      httpMethod: 'POST',
      resource: '/query',
      headers: {
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'test@example.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Bad Request');
  });

  test('should reject query request with empty email', async () => {
    const event = {
      httpMethod: 'POST',
      resource: '/query',
      headers: {
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: '', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Bad Request');
  });

  test('should handle query request with valid email but no record found', async () => {
    const event = {
      httpMethod: 'POST',
      resource: '/query',
      headers: {
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'nonexistent@example.com', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.found).toBe(false);
    expect(body.email).toBe('nonexistent@example.com');
    expect(body.message).toBe('No signup record found for this email');
  });

  test('should handle query request with case-insensitive email', async () => {
    const event = {
      httpMethod: 'POST',
      resource: '/query',
      headers: {
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'TEST@EXAMPLE.COM', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    // Should return 200 for valid query request (case doesn't matter for hashing)
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.found).toBeDefined();
  });

  test('should handle signup request with case-insensitive email', async () => {
    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'TEST@EXAMPLE.COM', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    // Should not return 400 (Bad Request) for valid email with different case
    expect(result.statusCode).not.toBe(400);
  });

  test('should handle malformed JSON in query request', async () => {
    const event = {
      httpMethod: 'POST',
      resource: '/query',
      headers: {
        origin: 'https://moviexclusives.com'
      },
      body: 'invalid json'
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Bad Request');
    expect(JSON.parse(result.body).message).toBe('Invalid JSON in request body');
  });

  test('should handle malformed JSON in signup request', async () => {
    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://moviexclusives.com'
      },
      body: 'invalid json'
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Bad Request');
    expect(JSON.parse(result.body).message).toBe('Invalid JSON in request body');
  });

  test('should handle query request with existing record', async () => {
    // Mock a successful record retrieval
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        id: 'test-hash',
        type: 'record',
        domain: 'moviexclusives.com',
        sequence_number: 42,
        status: 'success',
        timestamp: '2024-01-15T10:30:00.000Z'
      }
    });

    const event = {
      httpMethod: 'POST',
      resource: '/query',
      headers: {
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'existing@example.com', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.found).toBe(true);
    expect(body.email).toBe('existing@example.com');
    expect(body.domain).toBe('moviexclusives.com');
    expect(body.sequenceNumber).toBe(42);
    expect(body.status).toBe('success');
    expect(body.emailHash).toBeDefined();
  });

  test('should return existing sequence number if email already subscribed with success status', async () => {
    // Mock an existing record retrieval with success status
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        id: 'test-hash',
        type: 'record',
        domain: 'moviexclusives.com',
        sequence_number: 42,
        status: 'success',
        timestamp: '2024-01-15T10:30:00.000Z'
      }
    });

    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'existing@example.com', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Email already subscribed');
    expect(body.sequenceNumber).toBe(42);
    expect(body.email).toBe('existing@example.com');
    expect(body.domain).toBe('moviexclusives.com');
    expect(body.alreadySubscribed).toBe(true);
  });

  test('should proceed with new signup if existing record has error status', async () => {
    // Mock an existing record retrieval with error status
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        id: 'test-hash',
        type: 'record',
        domain: 'moviexclusives.com',
        sequence_number: 42,
        status: 'error',
        timestamp: '2024-01-15T10:30:00.000Z'
      }
    });

    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'error@example.com', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Email successfully subscribed');
    expect(body.sequenceNumber).toBe(42);
    expect(body.email).toBe('error@example.com');
    expect(body.domain).toBe('moviexclusives.com');
    expect(body.alreadySubscribed).toBe(false);
  });

  test('should proceed with new signup if email not found', async () => {
    // Mock no existing record found
    mockDynamoDB.send.mockResolvedValueOnce({ Item: null });

    const event = {
      httpMethod: 'POST',
      headers: {
        'x-api-key': 'test-api-key',
        origin: 'https://moviexclusives.com'
      },
      body: JSON.stringify({ email: 'new@example.com', domain: 'moviexclusives.com' })
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Email successfully subscribed');
    expect(body.sequenceNumber).toBe(42);
    expect(body.email).toBe('new@example.com');
    expect(body.domain).toBe('moviexclusives.com');
    expect(body.alreadySubscribed).toBe(false);
  });
}); 