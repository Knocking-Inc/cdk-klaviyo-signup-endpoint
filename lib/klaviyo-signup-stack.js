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
        // Uses esbuild-dist/ which contains the bundled output (includes axios, excludes aws-sdk)
        const signupFunction = new lambda.Function(this, 'SignupFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/esbuild-dist')),
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            environment: {
                SEQUENCE_TABLE_NAME: signupTable.tableName,
                SECRETS_NAME: 'prod/klaviyosignups',
                API_KEY: getApiKeyValue.getResponseField('value'),
                ALLOWED_DOMAINS: 'moviexclusives.com,localhost,cbsdeals.com,americasstealsanddeals.com,localstealsanddeals.com', // Comma-separated list
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia2xhdml5by1zaWdudXAtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJrbGF2aXlvLXNpZ251cC1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFFbkMsaURBQWlEO0FBQ2pELHFEQUFxRDtBQUNyRCx5REFBeUQ7QUFDekQsNkNBQTZDO0FBQzdDLGlFQUFpRTtBQUNqRSxtREFBbUQ7QUFDbkQsMkNBQTJDO0FBQzNDLDZCQUE2QjtBQUU3QixNQUFhLGtCQUFtQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQy9DLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsaUVBQWlFO1FBQ2pFLE1BQU0sV0FBVyxHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQzFELFNBQVMsRUFBRSxnQkFBZ0I7WUFDM0IsWUFBWSxFQUFFLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNLEVBQUU7WUFDakUsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNLEVBQUU7WUFDOUQsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXLENBQUMsZUFBZTtZQUNqRCxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGdDQUFnQyxFQUFFO2dCQUNoQywwQkFBMEIsRUFBRSxJQUFJO2FBQ2pDO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsMkRBQTJEO1FBQzNELFdBQVcsQ0FBQyx1QkFBdUIsQ0FBQztZQUNsQyxTQUFTLEVBQUUsbUJBQW1CO1lBQzlCLFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FB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QUFFLEdBQUcsR0FBRyxDQUFDLEdBQUcsUUFBUTtZQUN6QixXQUFXLEVBQUUsNEJBQTRCO1NBQzFDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFO1lBQ2xDLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSztZQUNuQixXQUFXLEVBQUUsNkRBQTZEO1NBQzNFLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ3JDLEtBQUssRUFBRSxjQUFjLENBQUMsZ0JBQWdCLENBQUMsT0FBTyxDQUFDO1lBQy9DLFdBQVcsRUFBRSxzREFBc0Q7U0FDcEUsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBcFBELGdEQW9QQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5IGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5JztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNlY3JldHNtYW5hZ2VyJztcbmltcG9ydCAqIGFzIGNyIGZyb20gJ2F3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXMnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcblxuZXhwb3J0IGNsYXNzIEtsYXZpeW9TaWdudXBTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIER5bmFtb0RCIHRhYmxlIGZvciBzdG9yaW5nIHNlcXVlbmNlIG51bWJlcnMgYW5kIHNpZ251cCByZWNvcmRzXG4gICAgY29uc3Qgc2lnbnVwVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ1NpZ251cFRhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiAna2xhdml5by1zaWdudXAnLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdpZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6ICd0eXBlJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLCAvLyBGb3IgZGV2ZWxvcG1lbnQgLSBjaGFuZ2UgdG8gUkVUQUlOIGZvciBwcm9kdWN0aW9uXG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgR1NJIGZvciBxdWVyeWluZyBzaWdudXAgcmVjb3JkcyBieSBkb21haW4gYW5kIHN0YXR1c1xuICAgIHNpZ251cFRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ0RvbWFpblN0YXR1c0luZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnZG9tYWluJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogJ3N0YXR1cycsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIEdTSSBmb3IgcXVlcnlpbmcgc2lnbnVwIHJlY29yZHMgYnkgc3RhdHVzIGFuZCB0aW1lc3RhbXBcbiAgICBzaWdudXBUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6ICdTdGF0dXNUaW1lc3RhbXBJbmRleCcsXG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogJ3N0YXR1cycsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6ICd0aW1lc3RhbXAnLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgcHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCxcbiAgICB9KTtcblxuICAgIC8vIEltcG9ydCB0aGUgZXhpc3Rpbmcgc2VjcmV0XG4gICAgY29uc3Qga2xhdml5b1NlY3JldHMgPSBzZWNyZXRzbWFuYWdlci5TZWNyZXQuZnJvbVNlY3JldE5hbWVWMih0aGlzLCAnS2xhdml5b1NlY3JldHMnLCAncHJvZC9rbGF2aXlvc2lnbnVwcycpO1xuXG4gICAgLy8gQ3JlYXRlIEFQSSBrZXkgYW5kIHVzYWdlIHBsYW4gZm9yIHJhdGUgbGltaXRpbmdcbiAgICBjb25zdCBhcGlLZXkgPSBuZXcgYXBpZ2F0ZXdheS5BcGlLZXkodGhpcywgJ1NpZ251cEFwaUtleScsIHtcbiAgICAgIGFwaUtleU5hbWU6ICdrbGF2aXlvLXNpZ251cC1hcGkta2V5JyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVBJIGtleSBmb3IgS2xhdml5byBzaWdudXAgZW5kcG9pbnQnLFxuICAgIH0pO1xuXG4gICAgLy8gQ3VzdG9tIHJlc291cmNlIHRvIGdldCB0aGUgQVBJIGtleSB2YWx1ZVxuICAgIGNvbnN0IGdldEFwaUtleVZhbHVlID0gbmV3IGNyLkF3c0N1c3RvbVJlc291cmNlKHRoaXMsICdHZXRBcGlLZXlWYWx1ZScsIHtcbiAgICAgIG9uQ3JlYXRlOiB7XG4gICAgICAgIHNlcnZpY2U6ICdBUElHYXRld2F5JyxcbiAgICAgICAgYWN0aW9uOiAnZ2V0QXBpS2V5JyxcbiAgICAgICAgcGFyYW1ldGVyczoge1xuICAgICAgICAgIGFwaUtleTogYXBpS2V5LmtleUlkLFxuICAgICAgICAgIGluY2x1ZGVWYWx1ZTogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoJ0FwaUtleVZhbHVlJyksXG4gICAgICB9LFxuICAgICAgb25VcGRhdGU6IHtcbiAgICAgICAgc2VydmljZTogJ0FQSUdhdGV3YXknLFxuICAgICAgICBhY3Rpb246ICdnZXRBcGlLZXknLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgYXBpS2V5OiBhcGlLZXkua2V5SWQsXG4gICAgICAgICAgaW5jbHVkZVZhbHVlOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBwaHlzaWNhbFJlc291cmNlSWQ6IGNyLlBoeXNpY2FsUmVzb3VyY2VJZC5vZignQXBpS2V5VmFsdWUnKSxcbiAgICAgIH0sXG4gICAgICBwb2xpY3k6IGNyLkF3c0N1c3RvbVJlc291cmNlUG9saWN5LmZyb21TdGF0ZW1lbnRzKFtcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICBhY3Rpb25zOiBbJ2FwaWdhdGV3YXk6R0VUJ10sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6YXBpZ2F0ZXdheToke3RoaXMucmVnaW9ufTo6L2FwaWtleXMvJHthcGlLZXkua2V5SWR9YF0sXG4gICAgICAgIH0pLFxuICAgICAgXSksXG4gICAgICBpbnN0YWxsTGF0ZXN0QXdzU2RrOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIC8vIExhbWJkYSBmdW5jdGlvbiBmb3IgdGhlIHNpZ251cCBlbmRwb2ludFxuICAgIC8vIFVzZXMgZXNidWlsZC1kaXN0LyB3aGljaCBjb250YWlucyB0aGUgYnVuZGxlZCBvdXRwdXQgKGluY2x1ZGVzIGF4aW9zLCBleGNsdWRlcyBhd3Mtc2RrKVxuICAgIGNvbnN0IHNpZ251cEZ1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnU2lnbnVwRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2VzYnVpbGQtZGlzdCcpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFNFUVVFTkNFX1RBQkxFX05BTUU6IHNpZ251cFRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgU0VDUkVUU19OQU1FOiAncHJvZC9rbGF2aXlvc2lnbnVwcycsXG4gICAgICAgIEFQSV9LRVk6IGdldEFwaUtleVZhbHVlLmdldFJlc3BvbnNlRmllbGQoJ3ZhbHVlJyksXG5BTExPV0VEX0RPTUFJTlM6ICdtb3ZpZXhjbHVzaXZlcy5jb20sbG9jYWxob3N0LGNic2RlYWxzLmNvbSxhbWVyaWNhc3N0ZWFsc2FuZGRlYWxzLmNvbSxsb2NhbHN0ZWFsc2FuZGRlYWxzLmNvbScsIC8vIENvbW1hLXNlcGFyYXRlZCBsaXN0XG4gICAgICB9LFxuICAgICAgbG9nUmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgfSk7XG5cbiAgICAvLyBHcmFudCBEeW5hbW9EQiBwZXJtaXNzaW9ucyB0byBMYW1iZGFcbiAgICBzaWdudXBUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoc2lnbnVwRnVuY3Rpb24pO1xuXG4gICAgLy8gR3JhbnQgU2VjcmV0cyBNYW5hZ2VyIHBlcm1pc3Npb25zIHRvIExhbWJkYVxuICAgIGtsYXZpeW9TZWNyZXRzLmdyYW50UmVhZChzaWdudXBGdW5jdGlvbik7XG5cbiAgICAvLyBBUEkgR2F0ZXdheVxuICAgIGNvbnN0IGFwaSA9IG5ldyBhcGlnYXRld2F5LlJlc3RBcGkodGhpcywgJ1NpZ251cEFwaScsIHtcbiAgICAgIHJlc3RBcGlOYW1lOiAnS2xhdml5byBTaWdudXAgQVBJJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVBJIGZvciBlbWFpbCBzaWdudXAgd2l0aCBLbGF2aXlvIGludGVncmF0aW9uJyxcbiAgICAgIGRlZmF1bHRDb3JzUHJlZmxpZ2h0T3B0aW9uczoge1xuICAgICAgICBhbGxvd09yaWdpbnM6IFsnKiddLCAvLyBXaWxsIGJlIG92ZXJyaWRkZW4gYnkgTGFtYmRhIGZ1bmN0aW9uIGZvciBzcGVjaWZpYyBkb21haW5zXG4gICAgICAgIGFsbG93TWV0aG9kczogYXBpZ2F0ZXdheS5Db3JzLkFMTF9NRVRIT0RTLFxuICAgICAgICBhbGxvd0hlYWRlcnM6IFsnQ29udGVudC1UeXBlJywgJ1gtQVBJLUtleSddLFxuICAgICAgICBtYXhBZ2U6IGNkay5EdXJhdGlvbi5kYXlzKDEpLFxuICAgICAgfSxcbiAgICAgIGRlcGxveU9wdGlvbnM6IHtcbiAgICAgICAgc3RhZ2VOYW1lOiAncHJvZCcsXG4gICAgICAgIGxvZ2dpbmdMZXZlbDogYXBpZ2F0ZXdheS5NZXRob2RMb2dnaW5nTGV2ZWwuSU5GTyxcbiAgICAgICAgZGF0YVRyYWNlRW5hYmxlZDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCB1c2FnZVBsYW4gPSBuZXcgYXBpZ2F0ZXdheS5Vc2FnZVBsYW4odGhpcywgJ1NpZ251cFVzYWdlUGxhbicsIHtcbiAgICAgIG5hbWU6ICdrbGF2aXlvLXNpZ251cC11c2FnZS1wbGFuJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVXNhZ2UgcGxhbiBmb3IgS2xhdml5byBzaWdudXAgZW5kcG9pbnQnLFxuICAgICAgdGhyb3R0bGU6IHtcbiAgICAgICAgcmF0ZUxpbWl0OiAxMDAsIC8vIDEwMCByZXF1ZXN0cyBwZXIgc2Vjb25kICh1cCBmcm9tIDEwKVxuICAgICAgICBidXJzdExpbWl0OiAyMDAsIC8vIEFsbG93IGJ1cnN0IG9mIDIwMCByZXF1ZXN0cyAodXAgZnJvbSAyMClcbiAgICAgIH0sXG4gICAgICBxdW90YToge1xuICAgICAgICBsaW1pdDogNTAwMDAwLCAvLyA1MDAsMDAwIHJlcXVlc3RzIHBlciBkYXkgKHVwIGZyb20gMSwwMDApXG4gICAgICAgIHBlcmlvZDogYXBpZ2F0ZXdheS5QZXJpb2QuREFZLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHVzYWdlUGxhbi5hZGRBcGlLZXkoYXBpS2V5KTtcbiAgICB1c2FnZVBsYW4uYWRkQXBpU3RhZ2Uoe1xuICAgICAgc3RhZ2U6IGFwaS5kZXBsb3ltZW50U3RhZ2UsXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgdGhlIHNpZ251cCByZXNvdXJjZSBhbmQgbWV0aG9kXG4gICAgY29uc3Qgc2lnbnVwUmVzb3VyY2UgPSBhcGkucm9vdC5hZGRSZXNvdXJjZSgnc2lnbnVwJyk7XG4gICAgY29uc3Qgc2lnbnVwSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheS5MYW1iZGFJbnRlZ3JhdGlvbihzaWdudXBGdW5jdGlvbiwge1xuICAgICAgcmVxdWVzdFRlbXBsYXRlczoge1xuICAgICAgICAnYXBwbGljYXRpb24vanNvbic6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBib2R5OiAnJHV0aWwuZXNjYXBlSmF2YVNjcmlwdCgkaW5wdXQuanNvbihcXCckXFwnKSknLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBzaWdudXBSZXNvdXJjZS5hZGRNZXRob2QoJ1BPU1QnLCBzaWdudXBJbnRlZ3JhdGlvbiwge1xuICAgICAgYXBpS2V5UmVxdWlyZWQ6IHRydWUsIC8vIFJlcXVpcmUgQVBJIGtleVxuICAgICAgYXV0aG9yaXphdGlvblR5cGU6IGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGUuTk9ORSxcbiAgICAgIHJlcXVlc3RWYWxpZGF0b3I6IG5ldyBhcGlnYXRld2F5LlJlcXVlc3RWYWxpZGF0b3IodGhpcywgJ1NpZ251cFZhbGlkYXRvcicsIHtcbiAgICAgICAgcmVzdEFwaTogYXBpLFxuICAgICAgICB2YWxpZGF0ZVJlcXVlc3RCb2R5OiB0cnVlLFxuICAgICAgICB2YWxpZGF0ZVJlcXVlc3RQYXJhbWV0ZXJzOiBmYWxzZSxcbiAgICAgIH0pLFxuICAgICAgcmVxdWVzdE1vZGVsczoge1xuICAgICAgICAnYXBwbGljYXRpb24vanNvbic6IG5ldyBhcGlnYXRld2F5Lk1vZGVsKHRoaXMsICdTaWdudXBNb2RlbCcsIHtcbiAgICAgICAgICByZXN0QXBpOiBhcGksXG4gICAgICAgICAgY29udGVudFR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICBtb2RlbE5hbWU6ICdTaWdudXBSZXF1ZXN0JyxcbiAgICAgICAgICBzY2hlbWE6IHtcbiAgICAgICAgICAgIHR5cGU6IGFwaWdhdGV3YXkuSnNvblNjaGVtYVR5cGUuT0JKRUNULFxuICAgICAgICAgICAgcmVxdWlyZWQ6IFsnZW1haWwnLCAnZG9tYWluJ10sXG4gICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgIGVtYWlsOiB7XG4gICAgICAgICAgICAgICAgdHlwZTogYXBpZ2F0ZXdheS5Kc29uU2NoZW1hVHlwZS5TVFJJTkcsXG4gICAgICAgICAgICAgICAgZm9ybWF0OiAnZW1haWwnLFxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnRW1haWwgYWRkcmVzcyB0byBzdWJzY3JpYmUnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBkb21haW46IHtcbiAgICAgICAgICAgICAgICB0eXBlOiBhcGlnYXRld2F5Lkpzb25TY2hlbWFUeXBlLlNUUklORyxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ0RvbWFpbiBmb3IgdGhlIHNpZ251cCAoZS5nLiwgbW92aWV4Y2x1c2l2ZXMuY29tKScsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHNob3dRdWV1ZVBvc2l0aW9uOiB7XG4gICAgICAgICAgICAgICAgdHlwZTogYXBpZ2F0ZXdheS5Kc29uU2NoZW1hVHlwZS5CT09MRUFOLFxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnV2hldGhlciB0byBnZW5lcmF0ZSBhbmQgcmV0dXJuIGEgc2VxdWVuY2UgbnVtYmVyJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgY3VzdG9tU291cmNlOiB7XG4gICAgICAgICAgICAgICAgdHlwZTogYXBpZ2F0ZXdheS5Kc29uU2NoZW1hVHlwZS5TVFJJTkcsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICdDdXN0b20gc291cmNlIHN0cmluZyBmb3IgS2xhdml5byAoZGVmYXVsdDogV2Vic2l0ZSBTaWdudXApJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIHRoZSBxdWVyeSByZXNvdXJjZSBhbmQgbWV0aG9kXG4gICAgY29uc3QgcXVlcnlSZXNvdXJjZSA9IGFwaS5yb290LmFkZFJlc291cmNlKCdxdWVyeScpO1xuICAgIGNvbnN0IHF1ZXJ5SW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheS5MYW1iZGFJbnRlZ3JhdGlvbihzaWdudXBGdW5jdGlvbiwge1xuICAgICAgcmVxdWVzdFRlbXBsYXRlczoge1xuICAgICAgICAnYXBwbGljYXRpb24vanNvbic6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBib2R5OiAnJHV0aWwuZXNjYXBlSmF2YVNjcmlwdCgkaW5wdXQuanNvbihcXCckXFwnKSknLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBxdWVyeVJlc291cmNlLmFkZE1ldGhvZCgnUE9TVCcsIHF1ZXJ5SW50ZWdyYXRpb24sIHtcbiAgICAgIGFwaUtleVJlcXVpcmVkOiBmYWxzZSwgLy8gTm8gQVBJIGtleSByZXF1aXJlZCBmb3IgcXVlcnkgZW5kcG9pbnRcbiAgICAgIGF1dGhvcml6YXRpb25UeXBlOiBhcGlnYXRld2F5LkF1dGhvcml6YXRpb25UeXBlLk5PTkUsXG4gICAgICByZXF1ZXN0VmFsaWRhdG9yOiBuZXcgYXBpZ2F0ZXdheS5SZXF1ZXN0VmFsaWRhdG9yKHRoaXMsICdRdWVyeVZhbGlkYXRvcicsIHtcbiAgICAgICAgcmVzdEFwaTogYXBpLFxuICAgICAgICB2YWxpZGF0ZVJlcXVlc3RCb2R5OiB0cnVlLFxuICAgICAgICB2YWxpZGF0ZVJlcXVlc3RQYXJhbWV0ZXJzOiB0cnVlLCAvLyBFbmFibGUgcXVlcnkgcGFyYW1ldGVyIHZhbGlkYXRpb25cbiAgICAgIH0pLFxuICAgICAgcmVxdWVzdFBhcmFtZXRlcnM6IHtcbiAgICAgICAgJ21ldGhvZC5yZXF1ZXN0LnF1ZXJ5c3RyaW5nLnJldHJ5JzogZmFsc2UsIC8vIE9wdGlvbmFsIHF1ZXJ5IHBhcmFtZXRlclxuICAgICAgfSxcbiAgICAgIHJlcXVlc3RNb2RlbHM6IHtcbiAgICAgICAgJ2FwcGxpY2F0aW9uL2pzb24nOiBuZXcgYXBpZ2F0ZXdheS5Nb2RlbCh0aGlzLCAnUXVlcnlNb2RlbCcsIHtcbiAgICAgICAgICByZXN0QXBpOiBhcGksXG4gICAgICAgICAgY29udGVudFR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICBtb2RlbE5hbWU6ICdRdWVyeVJlcXVlc3QnLFxuICAgICAgICAgIHNjaGVtYToge1xuICAgICAgICAgICAgdHlwZTogYXBpZ2F0ZXdheS5Kc29uU2NoZW1hVHlwZS5PQkpFQ1QsXG4gICAgICAgICAgICByZXF1aXJlZDogWydlbWFpbCcsICdkb21haW4nXSxcbiAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgZW1haWw6IHtcbiAgICAgICAgICAgICAgICB0eXBlOiBhcGlnYXRld2F5Lkpzb25TY2hlbWFUeXBlLlNUUklORyxcbiAgICAgICAgICAgICAgICBmb3JtYXQ6ICdlbWFpbCcsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICdFbWFpbCBhZGRyZXNzIHRvIHF1ZXJ5JyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgZG9tYWluOiB7XG4gICAgICAgICAgICAgICAgdHlwZTogYXBpZ2F0ZXdheS5Kc29uU2NoZW1hVHlwZS5TVFJJTkcsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICdEb21haW4gZm9yIHRoZSBxdWVyeSAoZS5nLiwgbW92aWV4Y2x1c2l2ZXMuY29tKScsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHNob3dRdWV1ZVBvc2l0aW9uOiB7XG4gICAgICAgICAgICAgICAgdHlwZTogYXBpZ2F0ZXdheS5Kc29uU2NoZW1hVHlwZS5CT09MRUFOLFxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAnV2hldGhlciB0byBpbmNsdWRlIHRoZSBzZXF1ZW5jZSBudW1iZXIgaW4gdGhlIHJlc3BvbnNlJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gT3V0cHV0IHRoZSBBUEkgZW5kcG9pbnQgVVJMIGFuZCBBUEkga2V5XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FwaVVybCcsIHtcbiAgICAgIHZhbHVlOiBgJHthcGkudXJsfXNpZ251cGAsXG4gICAgICBkZXNjcmlwdGlvbjogJ1VSTCBvZiB0aGUgc2lnbnVwIGVuZHBvaW50JyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlLZXlJZCcsIHtcbiAgICAgIHZhbHVlOiBhcGlLZXkua2V5SWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FQSSBLZXkgSUQgKHJldHJpZXZlIHRoZSBhY3R1YWwga2V5IHZhbHVlIGZyb20gQVdTIENvbnNvbGUpJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlLZXlWYWx1ZScsIHtcbiAgICAgIHZhbHVlOiBnZXRBcGlLZXlWYWx1ZS5nZXRSZXNwb25zZUZpZWxkKCd2YWx1ZScpLFxuICAgICAgZGVzY3JpcHRpb246ICdBUEkgS2V5IFZhbHVlICh1c2UgdGhpcyBpbiB5b3VyIGNsaWVudCBhcHBsaWNhdGlvbnMpJyxcbiAgICB9KTtcbiAgfVxufSAiXX0=