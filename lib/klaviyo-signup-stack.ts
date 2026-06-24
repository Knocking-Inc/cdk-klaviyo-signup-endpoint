import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export class KlaviyoSignupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB table for storing sequence numbers and signup records
    const signupTable = new dynamodb.Table(this, 'SignupTable', {
      tableName: 'klaviyo-signup',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'type', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For development - change to RETAIN for production
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // Add GSI for querying signup records by domain and status
    signupTable.addGlobalSecondaryIndex({
      indexName: 'DomainStatusIndex',
      partitionKey: { name: 'domain', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Add GSI for querying signup records by status and timestamp
    signupTable.addGlobalSecondaryIndex({
      indexName: 'StatusTimestampIndex',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Import the existing secret
    const klaviyoSecrets = secretsmanager.Secret.fromSecretNameV2(this, 'KlaviyoSecrets', 'prod/klaviyosignups');

    // Create API key and usage plan for rate limiting
    const apiKey = new apigateway.ApiKey(this, 'SignupApiKey', {
      apiKeyName: 'klaviyo-signup-api-key',
      description: 'API key for Klaviyo signup endpoint',
    });

    // Custom resource to get the API key value
    const getApiKeyValue = new cr.AwsCustomResource(this, 'GetApiKeyValue', {
      onCreate: {
        service: 'APIGateway',
        action: 'getApiKey',
        parameters: {
          apiKey: apiKey.keyId,
          includeValue: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of('ApiKeyValue'),
      },
      onUpdate: {
        service: 'APIGateway',
        action: 'getApiKey',
        parameters: {
          apiKey: apiKey.keyId,
          includeValue: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of('ApiKeyValue'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['apigateway:GET'],
          resources: [`arn:aws:apigateway:${this.region}::/apikeys/${apiKey.keyId}`],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    // Lambda function for the signup endpoint
    const signupFunction = new lambda.Function(this, 'SignupFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        SEQUENCE_TABLE_NAME: signupTable.tableName,
        SECRETS_NAME: 'prod/klaviyosignups',
        API_KEY: getApiKeyValue.getResponseField('value'),
        ALLOWED_DOMAINS: 'moviexclusives.com,localhost', // Comma-separated list
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Grant DynamoDB permissions to Lambda
    signupTable.grantReadWriteData(signupFunction);

    // Grant Secrets Manager permissions to Lambda
    klaviyoSecrets.grantRead(signupFunction);

    // API Gateway
    const api = new apigateway.RestApi(this, 'SignupApi', {
      restApiName: 'Klaviyo Signup API',
      description: 'API for email signup with Klaviyo integration',
      defaultCorsPreflightOptions: {
        allowOrigins: ['*'], // Will be overridden by Lambda function for specific domains
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-API-Key'],
        maxAge: cdk.Duration.days(1),
      },
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
    });

    const usagePlan = new apigateway.UsagePlan(this, 'SignupUsagePlan', {
      name: 'klaviyo-signup-usage-plan',
      description: 'Usage plan for Klaviyo signup endpoint',
      throttle: {
        rateLimit: 100, // 100 requests per second (up from 10)
        burstLimit: 200, // Allow burst of 200 requests (up from 20)
      },
      quota: {
        limit: 500000, // 500,000 requests per day (up from 1,000)
        period: apigateway.Period.DAY,
      },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({
      stage: api.deploymentStage,
    });

    // Create the signup resource and method
    const signupResource = api.root.addResource('signup');
    const signupIntegration = new apigateway.LambdaIntegration(signupFunction, {
      requestTemplates: {
        'application/json': JSON.stringify({
          body: '$util.escapeJavaScript($input.json(\'$\'))',
        }),
      },
    });

    signupResource.addMethod('POST', signupIntegration, {
      apiKeyRequired: true, // Require API key
      authorizationType: apigateway.AuthorizationType.NONE,
      requestValidator: new apigateway.RequestValidator(this, 'SignupValidator', {
        restApi: api,
        validateRequestBody: true,
        validateRequestParameters: false,
      }),
      requestModels: {
        'application/json': new apigateway.Model(this, 'SignupModel', {
          restApi: api,
          contentType: 'application/json',
          modelName: 'SignupRequest',
          schema: {
            type: apigateway.JsonSchemaType.OBJECT,
            required: ['email', 'domain'],
            properties: {
              email: {
                type: apigateway.JsonSchemaType.STRING,
                format: 'email',
                description: 'Email address to subscribe',
              },
              domain: {
                type: apigateway.JsonSchemaType.STRING,
                description: 'Domain for the signup (e.g., moviexclusives.com)',
              },
              showQueuePosition: {
                type: apigateway.JsonSchemaType.BOOLEAN,
                description: 'Whether to generate and return a sequence number',
              },
              customSource: {
                type: apigateway.JsonSchemaType.STRING,
                description: 'Custom source string for Klaviyo (default: Website Signup)',
              },
            },
          },
        }),
      },
    });

    // Create the query resource and method
    const queryResource = api.root.addResource('query');
    const queryIntegration = new apigateway.LambdaIntegration(signupFunction, {
      requestTemplates: {
        'application/json': JSON.stringify({
          body: '$util.escapeJavaScript($input.json(\'$\'))',
        }),
      },
    });

    queryResource.addMethod('POST', queryIntegration, {
      apiKeyRequired: false, // No API key required for query endpoint
      authorizationType: apigateway.AuthorizationType.NONE,
      requestValidator: new apigateway.RequestValidator(this, 'QueryValidator', {
        restApi: api,
        validateRequestBody: true,
        validateRequestParameters: true, // Enable query parameter validation
      }),
      requestParameters: {
        'method.request.querystring.retry': false, // Optional query parameter
      },
      requestModels: {
        'application/json': new apigateway.Model(this, 'QueryModel', {
          restApi: api,
          contentType: 'application/json',
          modelName: 'QueryRequest',
          schema: {
            type: apigateway.JsonSchemaType.OBJECT,
            required: ['email', 'domain'],
            properties: {
              email: {
                type: apigateway.JsonSchemaType.STRING,
                format: 'email',
                description: 'Email address to query',
              },
              domain: {
                type: apigateway.JsonSchemaType.STRING,
                description: 'Domain for the query (e.g., moviexclusives.com)',
              },
              showQueuePosition: {
                type: apigateway.JsonSchemaType.BOOLEAN,
                description: 'Whether to include the sequence number in the response',
              },
            },
          },
        }),
      },
    });

    // Output the API endpoint URL and API key
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `${api.url}signup`,
      description: 'URL of the signup endpoint',
    });

    new cdk.CfnOutput(this, 'ApiKeyId', {
      value: apiKey.keyId,
      description: 'API Key ID (retrieve the actual key value from AWS Console)',
    });

    new cdk.CfnOutput(this, 'ApiKeyValue', {
      value: getApiKeyValue.getResponseField('value'),
      description: 'API Key Value (use this in your client applications)',
    });
  }
} 