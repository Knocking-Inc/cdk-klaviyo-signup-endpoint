"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KlaviyoSignupStack = void 0;
const cdk = require("aws-cdk-lib");
const lambda = require("aws-cdk-lib/aws-lambda");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const apigateway = require("aws-cdk-lib/aws-apigateway");
const logs = require("aws-cdk-lib/aws-logs");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
const cr = require("aws-cdk-lib/custom-resources");
const iam = require("aws-cdk-lib/aws-iam");
const path = require("path");
class KlaviyoSignupStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // DynamoDB table for storing sequence numbers and signup records
        const signupTable = new dynamodb.Table(this, 'SignupTable', {
            tableName: 'klaviyo-signup',
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'type', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
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
                allowOrigins: ['*'],
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
                rateLimit: 100,
                burstLimit: 200, // Allow burst of 200 requests (up from 20)
            },
            quota: {
                limit: 500000,
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
            apiKeyRequired: true,
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
            apiKeyRequired: false,
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
exports.KlaviyoSignupStack = KlaviyoSignupStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia2xhdml5by1zaWdudXAtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJrbGF2aXlvLXNpZ251cC1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFFbkMsaURBQWlEO0FBQ2pELHFEQUFxRDtBQUNyRCx5REFBeUQ7QUFDekQsNkNBQTZDO0FBQzdDLGlFQUFpRTtBQUNqRSxtREFBbUQ7QUFDbkQsMkNBQTJDO0FBQzNDLDZCQUE2QjtBQUU3QixNQUFhLGtCQUFtQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQy9DLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsaUVBQWlFO1FBQ2pFLE1BQU0sV0FBVyxHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQzFELFNBQVMsRUFBRSxnQkFBZ0I7WUFDM0IsWUFBWSxFQUFFLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNLEVBQUU7WUFDakUsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNLEVBQUU7WUFDOUQsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXLENBQUMsZUFBZTtZQUNqRCxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGdDQUFnQyxFQUFFO2dCQUNoQywwQkFBMEIsRUFBRSxJQUFJO2FBQ2pDO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsMkRBQTJEO1FBQzNELFdBQVcsQ0FBQyx1QkFBdUIsQ0FBQztZQUNsQyxTQUFTLEVBQUUsbUJBQW1CO1lBQzlCLFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FB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RUFBRSxVQUFVLEVBQUU7WUFDbEMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxLQUFLO1lBQ25CLFdBQVcsRUFBRSw2REFBNkQ7U0FDM0UsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDckMsS0FBSyxFQUFFLGNBQWMsQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLENBQUM7WUFDL0MsV0FBVyxFQUFFLHNEQUFzRDtTQUNwRSxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUEvT0QsZ0RBK09DIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiJztcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXknO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBzZWNyZXRzbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXInO1xuaW1wb3J0ICogYXMgY3IgZnJvbSAnYXdzLWNkay1saWIvY3VzdG9tLXJlc291cmNlcyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5leHBvcnQgY2xhc3MgS2xhdml5b1NpZ251cFN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gRHluYW1vREIgdGFibGUgZm9yIHN0b3Jpbmcgc2VxdWVuY2UgbnVtYmVycyBhbmQgc2lnbnVwIHJlY29yZHNcbiAgICBjb25zdCBzaWdudXBUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnU2lnbnVwVGFibGUnLCB7XG4gICAgICB0YWJsZU5hbWU6ICdrbGF2aXlvLXNpZ251cCcsXG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogJ2lkJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogJ3R5cGUnLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksIC8vIEZvciBkZXZlbG9wbWVudCAtIGNoYW5nZSB0byBSRVRBSU4gZm9yIHByb2R1Y3Rpb25cbiAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBHU0kgZm9yIHF1ZXJ5aW5nIHNpZ251cCByZWNvcmRzIGJ5IGRvbWFpbiBhbmQgc3RhdHVzXG4gICAgc2lnbnVwVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgaW5kZXhOYW1lOiAnRG9tYWluU3RhdHVzSW5kZXgnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdkb21haW4nLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiAnc3RhdHVzJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgR1NJIGZvciBxdWVyeWluZyBzaWdudXAgcmVjb3JkcyBieSBzdGF0dXMgYW5kIHRpbWVzdGFtcFxuICAgIHNpZ251cFRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ1N0YXR1c1RpbWVzdGFtcEluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnc3RhdHVzJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogJ3RpbWVzdGFtcCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gSW1wb3J0IHRoZSBleGlzdGluZyBzZWNyZXRcbiAgICBjb25zdCBrbGF2aXlvU2VjcmV0cyA9IHNlY3JldHNtYW5hZ2VyLlNlY3JldC5mcm9tU2VjcmV0TmFtZVYyKHRoaXMsICdLbGF2aXlvU2VjcmV0cycsICdwcm9kL2tsYXZpeW9zaWdudXBzJyk7XG5cbiAgICAvLyBDcmVhdGUgQVBJIGtleSBhbmQgdXNhZ2UgcGxhbiBmb3IgcmF0ZSBsaW1pdGluZ1xuICAgIGNvbnN0IGFwaUtleSA9IG5ldyBhcGlnYXRld2F5LkFwaUtleSh0aGlzLCAnU2lnbnVwQXBpS2V5Jywge1xuICAgICAgYXBpS2V5TmFtZTogJ2tsYXZpeW8tc2lnbnVwLWFwaS1rZXknLFxuICAgICAgZGVzY3JpcHRpb246ICdBUEkga2V5IGZvciBLbGF2aXlvIHNpZ251cCBlbmRwb2ludCcsXG4gICAgfSk7XG5cbiAgICAvLyBDdXN0b20gcmVzb3VyY2UgdG8gZ2V0IHRoZSBBUEkga2V5IHZhbHVlXG4gICAgY29uc3QgZ2V0QXBpS2V5VmFsdWUgPSBuZXcgY3IuQXdzQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0dldEFwaUtleVZhbHVlJywge1xuICAgICAgb25DcmVhdGU6IHtcbiAgICAgICAgc2VydmljZTogJ0FQSUdhdGV3YXknLFxuICAgICAgICBhY3Rpb246ICdnZXRBcGlLZXknLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgYXBpS2V5OiBhcGlLZXkua2V5SWQsXG4gICAgICAgICAgaW5jbHVkZVZhbHVlOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBwaHlzaWNhbFJlc291cmNlSWQ6IGNyLlBoeXNpY2FsUmVzb3VyY2VJZC5vZignQXBpS2V5VmFsdWUnKSxcbiAgICAgIH0sXG4gICAgICBvblVwZGF0ZToge1xuICAgICAgICBzZXJ2aWNlOiAnQVBJR2F0ZXdheScsXG4gICAgICAgIGFjdGlvbjogJ2dldEFwaUtleScsXG4gICAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgICBhcGlLZXk6IGFwaUtleS5rZXlJZCxcbiAgICAgICAgICBpbmNsdWRlVmFsdWU6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLm9mKCdBcGlLZXlWYWx1ZScpLFxuICAgICAgfSxcbiAgICAgIHBvbGljeTogY3IuQXdzQ3VzdG9tUmVzb3VyY2VQb2xpY3kuZnJvbVN0YXRlbWVudHMoW1xuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgIGFjdGlvbnM6IFsnYXBpZ2F0ZXdheTpHRVQnXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czphcGlnYXRld2F5OiR7dGhpcy5yZWdpb259OjovYXBpa2V5cy8ke2FwaUtleS5rZXlJZH1gXSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICAgIGluc3RhbGxMYXRlc3RBd3NTZGs6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgLy8gTGFtYmRhIGZ1bmN0aW9uIGZvciB0aGUgc2lnbnVwIGVuZHBvaW50XG4gICAgY29uc3Qgc2lnbnVwRnVuY3Rpb24gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdTaWdudXBGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEnKSksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBTRVFVRU5DRV9UQUJMRV9OQU1FOiBzaWdudXBUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFNFQ1JFVFNfTkFNRTogJ3Byb2Qva2xhdml5b3NpZ251cHMnLFxuICAgICAgICBBUElfS0VZOiBnZXRBcGlLZXlWYWx1ZS5nZXRSZXNwb25zZUZpZWxkKCd2YWx1ZScpLFxuICAgICAgICBBTExPV0VEX0RPTUFJTlM6ICdtb3ZpZXhjbHVzaXZlcy5jb20sbG9jYWxob3N0JywgLy8gQ29tbWEtc2VwYXJhdGVkIGxpc3RcbiAgICAgIH0sXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IER5bmFtb0RCIHBlcm1pc3Npb25zIHRvIExhbWJkYVxuICAgIHNpZ251cFRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShzaWdudXBGdW5jdGlvbik7XG5cbiAgICAvLyBHcmFudCBTZWNyZXRzIE1hbmFnZXIgcGVybWlzc2lvbnMgdG8gTGFtYmRhXG4gICAga2xhdml5b1NlY3JldHMuZ3JhbnRSZWFkKHNpZ251cEZ1bmN0aW9uKTtcblxuICAgIC8vIEFQSSBHYXRld2F5XG4gICAgY29uc3QgYXBpID0gbmV3IGFwaWdhdGV3YXkuUmVzdEFwaSh0aGlzLCAnU2lnbnVwQXBpJywge1xuICAgICAgcmVzdEFwaU5hbWU6ICdLbGF2aXlvIFNpZ251cCBBUEknLFxuICAgICAgZGVzY3JpcHRpb246ICdBUEkgZm9yIGVtYWlsIHNpZ251cCB3aXRoIEtsYXZpeW8gaW50ZWdyYXRpb24nLFxuICAgICAgZGVmYXVsdENvcnNQcmVmbGlnaHRPcHRpb25zOiB7XG4gICAgICAgIGFsbG93T3JpZ2luczogWycqJ10sIC8vIFdpbGwgYmUgb3ZlcnJpZGRlbiBieSBMYW1iZGEgZnVuY3Rpb24gZm9yIHNwZWNpZmljIGRvbWFpbnNcbiAgICAgICAgYWxsb3dNZXRob2RzOiBhcGlnYXRld2F5LkNvcnMuQUxMX01FVEhPRFMsXG4gICAgICAgIGFsbG93SGVhZGVyczogWydDb250ZW50LVR5cGUnLCAnWC1BUEktS2V5J10sXG4gICAgICAgIG1heEFnZTogY2RrLkR1cmF0aW9uLmRheXMoMSksXG4gICAgICB9LFxuICAgICAgZGVwbG95T3B0aW9uczoge1xuICAgICAgICBzdGFnZU5hbWU6ICdwcm9kJyxcbiAgICAgICAgbG9nZ2luZ0xldmVsOiBhcGlnYXRld2F5Lk1ldGhvZExvZ2dpbmdMZXZlbC5JTkZPLFxuICAgICAgICBkYXRhVHJhY2VFbmFibGVkOiB0cnVlLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHVzYWdlUGxhbiA9IG5ldyBhcGlnYXRld2F5LlVzYWdlUGxhbih0aGlzLCAnU2lnbnVwVXNhZ2VQbGFuJywge1xuICAgICAgbmFtZTogJ2tsYXZpeW8tc2lnbnVwLXVzYWdlLXBsYW4nLFxuICAgICAgZGVzY3JpcHRpb246ICdVc2FnZSBwbGFuIGZvciBLbGF2aXlvIHNpZ251cCBlbmRwb2ludCcsXG4gICAgICB0aHJvdHRsZToge1xuICAgICAgICByYXRlTGltaXQ6IDEwMCwgLy8gMTAwIHJlcXVlc3RzIHBlciBzZWNvbmQgKHVwIGZyb20gMTApXG4gICAgICAgIGJ1cnN0TGltaXQ6IDIwMCwgLy8gQWxsb3cgYnVyc3Qgb2YgMjAwIHJlcXVlc3RzICh1cCBmcm9tIDIwKVxuICAgICAgfSxcbiAgICAgIHF1b3RhOiB7XG4gICAgICAgIGxpbWl0OiA1MDAwMDAsIC8vIDUwMCwwMDAgcmVxdWVzdHMgcGVyIGRheSAodXAgZnJvbSAxLDAwMClcbiAgICAgICAgcGVyaW9kOiBhcGlnYXRld2F5LlBlcmlvZC5EQVksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdXNhZ2VQbGFuLmFkZEFwaUtleShhcGlLZXkpO1xuICAgIHVzYWdlUGxhbi5hZGRBcGlTdGFnZSh7XG4gICAgICBzdGFnZTogYXBpLmRlcGxveW1lbnRTdGFnZSxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSB0aGUgc2lnbnVwIHJlc291cmNlIGFuZCBtZXRob2RcbiAgICBjb25zdCBzaWdudXBSZXNvdXJjZSA9IGFwaS5yb290LmFkZFJlc291cmNlKCdzaWdudXAnKTtcbiAgICBjb25zdCBzaWdudXBJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5LkxhbWJkYUludGVncmF0aW9uKHNpZ251cEZ1bmN0aW9uLCB7XG4gICAgICByZXF1ZXN0VGVtcGxhdGVzOiB7XG4gICAgICAgICdhcHBsaWNhdGlvbi9qc29uJzogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIGJvZHk6ICckdXRpbC5lc2NhcGVKYXZhU2NyaXB0KCRpbnB1dC5qc29uKFxcJyRcXCcpKScsXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHNpZ251cFJlc291cmNlLmFkZE1ldGhvZCgnUE9TVCcsIHNpZ251cEludGVncmF0aW9uLCB7XG4gICAgICBhcGlLZXlSZXF1aXJlZDogdHJ1ZSwgLy8gUmVxdWlyZSBBUEkga2V5XG4gICAgICBhdXRob3JpemF0aW9uVHlwZTogYXBpZ2F0ZXdheS5BdXRob3JpemF0aW9uVHlwZS5OT05FLFxuICAgICAgcmVxdWVzdFZhbGlkYXRvcjogbmV3IGFwaWdhdGV3YXkuUmVxdWVzdFZhbGlkYXRvcih0aGlzLCAnU2lnbnVwVmFsaWRhdG9yJywge1xuICAgICAgICByZXN0QXBpOiBhcGksXG4gICAgICAgIHZhbGlkYXRlUmVxdWVzdEJvZHk6IHRydWUsXG4gICAgICAgIHZhbGlkYXRlUmVxdWVzdFBhcmFtZXRlcnM6IGZhbHNlLFxuICAgICAgfSksXG4gICAgICByZXF1ZXN0TW9kZWxzOiB7XG4gICAgICAgICdhcHBsaWNhdGlvbi9qc29uJzogbmV3IGFwaWdhdGV3YXkuTW9kZWwodGhpcywgJ1NpZ251cE1vZGVsJywge1xuICAgICAgICAgIHJlc3RBcGk6IGFwaSxcbiAgICAgICAgICBjb250ZW50VHlwZTogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgIG1vZGVsTmFtZTogJ1NpZ251cFJlcXVlc3QnLFxuICAgICAgICAgIHNjaGVtYToge1xuICAgICAgICAgICAgdHlwZTogYXBpZ2F0ZXdheS5Kc29uU2NoZW1hVHlwZS5PQkpFQ1QsXG4gICAgICAgICAgICByZXF1aXJlZDogWydlbWFpbCcsICdkb21haW4nXSxcbiAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgZW1haWw6IHtcbiAgICAgICAgICAgICAgICB0eXBlOiBhcGlnYXRld2F5Lkpzb25TY2hlbWFUeXBlLlNUUklORyxcbiAgICAgICAgICAgICAgICBmb3JtYXQ6ICdlbWFpbCcsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICdFbWFpbCBhZGRyZXNzIHRvIHN1YnNjcmliZScsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGRvbWFpbjoge1xuICAgICAgICAgICAgICAgIHR5cGU6IGFwaWdhdGV3YXkuSnNvblNjaGVtYVR5cGUuU1RSSU5HLFxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnRG9tYWluIGZvciB0aGUgc2lnbnVwIChlLmcuLCBtb3ZpZXhjbHVzaXZlcy5jb20pJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgc2hvd1F1ZXVlUG9zaXRpb246IHtcbiAgICAgICAgICAgICAgICB0eXBlOiBhcGlnYXRld2F5Lkpzb25TY2hlbWFUeXBlLkJPT0xFQU4sXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICdXaGV0aGVyIHRvIGdlbmVyYXRlIGFuZCByZXR1cm4gYSBzZXF1ZW5jZSBudW1iZXInLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgdGhlIHF1ZXJ5IHJlc291cmNlIGFuZCBtZXRob2RcbiAgICBjb25zdCBxdWVyeVJlc291cmNlID0gYXBpLnJvb3QuYWRkUmVzb3VyY2UoJ3F1ZXJ5Jyk7XG4gICAgY29uc3QgcXVlcnlJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5LkxhbWJkYUludGVncmF0aW9uKHNpZ251cEZ1bmN0aW9uLCB7XG4gICAgICByZXF1ZXN0VGVtcGxhdGVzOiB7XG4gICAgICAgICdhcHBsaWNhdGlvbi9qc29uJzogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIGJvZHk6ICckdXRpbC5lc2NhcGVKYXZhU2NyaXB0KCRpbnB1dC5qc29uKFxcJyRcXCcpKScsXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHF1ZXJ5UmVzb3VyY2UuYWRkTWV0aG9kKCdQT1NUJywgcXVlcnlJbnRlZ3JhdGlvbiwge1xuICAgICAgYXBpS2V5UmVxdWlyZWQ6IGZhbHNlLCAvLyBObyBBUEkga2V5IHJlcXVpcmVkIGZvciBxdWVyeSBlbmRwb2ludFxuICAgICAgYXV0aG9yaXphdGlvblR5cGU6IGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGUuTk9ORSxcbiAgICAgIHJlcXVlc3RWYWxpZGF0b3I6IG5ldyBhcGlnYXRld2F5LlJlcXVlc3RWYWxpZGF0b3IodGhpcywgJ1F1ZXJ5VmFsaWRhdG9yJywge1xuICAgICAgICByZXN0QXBpOiBhcGksXG4gICAgICAgIHZhbGlkYXRlUmVxdWVzdEJvZHk6IHRydWUsXG4gICAgICAgIHZhbGlkYXRlUmVxdWVzdFBhcmFtZXRlcnM6IHRydWUsIC8vIEVuYWJsZSBxdWVyeSBwYXJhbWV0ZXIgdmFsaWRhdGlvblxuICAgICAgfSksXG4gICAgICByZXF1ZXN0UGFyYW1ldGVyczoge1xuICAgICAgICAnbWV0aG9kLnJlcXVlc3QucXVlcnlzdHJpbmcucmV0cnknOiBmYWxzZSwgLy8gT3B0aW9uYWwgcXVlcnkgcGFyYW1ldGVyXG4gICAgICB9LFxuICAgICAgcmVxdWVzdE1vZGVsczoge1xuICAgICAgICAnYXBwbGljYXRpb24vanNvbic6IG5ldyBhcGlnYXRld2F5Lk1vZGVsKHRoaXMsICdRdWVyeU1vZGVsJywge1xuICAgICAgICAgIHJlc3RBcGk6IGFwaSxcbiAgICAgICAgICBjb250ZW50VHlwZTogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgIG1vZGVsTmFtZTogJ1F1ZXJ5UmVxdWVzdCcsXG4gICAgICAgICAgc2NoZW1hOiB7XG4gICAgICAgICAgICB0eXBlOiBhcGlnYXRld2F5Lkpzb25TY2hlbWFUeXBlLk9CSkVDVCxcbiAgICAgICAgICAgIHJlcXVpcmVkOiBbJ2VtYWlsJywgJ2RvbWFpbiddLFxuICAgICAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgICBlbWFpbDoge1xuICAgICAgICAgICAgICAgIHR5cGU6IGFwaWdhdGV3YXkuSnNvblNjaGVtYVR5cGUuU1RSSU5HLFxuICAgICAgICAgICAgICAgIGZvcm1hdDogJ2VtYWlsJyxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ0VtYWlsIGFkZHJlc3MgdG8gcXVlcnknLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBkb21haW46IHtcbiAgICAgICAgICAgICAgICB0eXBlOiBhcGlnYXRld2F5Lkpzb25TY2hlbWFUeXBlLlNUUklORyxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ0RvbWFpbiBmb3IgdGhlIHF1ZXJ5IChlLmcuLCBtb3ZpZXhjbHVzaXZlcy5jb20pJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgc2hvd1F1ZXVlUG9zaXRpb246IHtcbiAgICAgICAgICAgICAgICB0eXBlOiBhcGlnYXRld2F5Lkpzb25TY2hlbWFUeXBlLkJPT0xFQU4sXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICdXaGV0aGVyIHRvIGluY2x1ZGUgdGhlIHNlcXVlbmNlIG51bWJlciBpbiB0aGUgcmVzcG9uc2UnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBPdXRwdXQgdGhlIEFQSSBlbmRwb2ludCBVUkwgYW5kIEFQSSBrZXlcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXBpVXJsJywge1xuICAgICAgdmFsdWU6IGAke2FwaS51cmx9c2lnbnVwYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVVJMIG9mIHRoZSBzaWdudXAgZW5kcG9pbnQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwaUtleUlkJywge1xuICAgICAgdmFsdWU6IGFwaUtleS5rZXlJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVBJIEtleSBJRCAocmV0cmlldmUgdGhlIGFjdHVhbCBrZXkgdmFsdWUgZnJvbSBBV1MgQ29uc29sZSknLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwaUtleVZhbHVlJywge1xuICAgICAgdmFsdWU6IGdldEFwaUtleVZhbHVlLmdldFJlc3BvbnNlRmllbGQoJ3ZhbHVlJyksXG4gICAgICBkZXNjcmlwdGlvbjogJ0FQSSBLZXkgVmFsdWUgKHVzZSB0aGlzIGluIHlvdXIgY2xpZW50IGFwcGxpY2F0aW9ucyknLFxuICAgIH0pO1xuICB9XG59ICJdfQ==