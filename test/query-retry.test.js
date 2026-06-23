const { handler } = require('../lambda/index');

// Mock environment variables
process.env.SEQUENCE_TABLE_NAME = 'test-table';
process.env.SECRETS_NAME = 'test-secrets';
process.env.API_KEY = 'test-api-key';
process.env.ALLOWED_DOMAINS = 'test.com,localhost';

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
  GetCommand: jest.fn()
}));

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => mockSecretsManager),
  GetSecretValueCommand: jest.fn()
}));

describe('Query Endpoint Retry Functionality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createQueryEvent = (email, retry = false) => ({
    httpMethod: 'POST',
    resource: '/query',
    path: '/query',
    headers: {
      'Content-Type': 'application/json'
    },
    queryStringParameters: retry ? { retry: 'true' } : null,
    body: JSON.stringify({ email, domain: 'test.com' })
  });

  test('should return immediately without retry when retry parameter is not present', async () => {
    // Mock DynamoDB to return no record
    mockDynamoDB.send.mockResolvedValue({ Item: null });

    const event = createQueryEvent('test@example.com', false);
    
    const response = await handler(event);
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.found).toBe(false);
    expect(body.attempts).toBe(1);
    expect(body.retried).toBe(false);
    expect(mockDynamoDB.send).toHaveBeenCalledTimes(1);
  });

  test('should retry up to 5 times when retry parameter is present and no record found', async () => {
    // Mock DynamoDB to return no record for all attempts
    mockDynamoDB.send.mockResolvedValue({ Item: null });

    const event = createQueryEvent('test@example.com', true);
    
    const responsePromise = handler(event);
    
    // Fast-forward time to simulate retries
    jest.advanceTimersByTime(5000);
    
    const response = await responsePromise;
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.found).toBe(false);
    expect(body.attempts).toBe(5);
    expect(body.retried).toBe(true);
    expect(mockDynamoDB.send).toHaveBeenCalledTimes(5);
  });

  test('should return early when record is found during retry', async () => {
    // Mock DynamoDB to return no record for first 2 attempts, then a record
    mockDynamoDB.send
      .mockResolvedValueOnce({ Item: null })
      .mockResolvedValueOnce({ Item: null })
      .mockResolvedValueOnce({ 
        Item: {
          domain: 'test.com',
          sequence_number: 42,
          status: 'success',
          timestamp: '2024-01-15T10:30:00.000Z'
        }
      });

    const event = createQueryEvent('test@example.com', true);
    
    const responsePromise = handler(event);
    
    // Fast-forward time to simulate retries
    jest.advanceTimersByTime(2000);
    
    const response = await responsePromise;
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.found).toBe(true);
    expect(body.attempts).toBe(3);
    expect(body.sequenceNumber).toBe(42);
    expect(mockDynamoDB.send).toHaveBeenCalledTimes(3);
  });

  test('should accept retry=1 as valid retry parameter', async () => {
    // Mock DynamoDB to return no record
    mockDynamoDB.send.mockResolvedValue({ Item: null });

    const event = createQueryEvent('test@example.com', false);
    event.queryStringParameters = { retry: '1' };
    
    const responsePromise = handler(event);
    
    // Fast-forward time to simulate retries
    jest.advanceTimersByTime(5000);
    
    const response = await responsePromise;
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.found).toBe(false);
    expect(body.attempts).toBe(5);
    expect(body.retried).toBe(true);
    expect(mockDynamoDB.send).toHaveBeenCalledTimes(5);
  });

  test('should handle invalid retry parameter values', async () => {
    // Mock DynamoDB to return no record
    mockDynamoDB.send.mockResolvedValue({ Item: null });

    const event = createQueryEvent('test@example.com', false);
    event.queryStringParameters = { retry: 'invalid' };
    
    const response = await handler(event);
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.found).toBe(false);
    expect(body.attempts).toBe(1);
    expect(body.retried).toBe(false);
    expect(mockDynamoDB.send).toHaveBeenCalledTimes(1);
  });
}); 