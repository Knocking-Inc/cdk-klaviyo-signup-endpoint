#!/bin/bash

# Klaviyo Signup Endpoint Deployment Script

set -e

echo "🚀 Starting deployment of Klaviyo Signup Endpoint..."

# Check if AWS CLI is configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS CLI is not configured. Please run 'aws configure' first."
    exit 1
fi

# Check if CDK is installed
if ! command -v cdk &> /dev/null; then
    echo "❌ CDK CLI is not installed. Please install it with 'npm install -g aws-cdk'"
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Install Lambda dependencies
echo "📦 Installing Lambda dependencies..."
cd lambda
npm install
cd ..

# Build the TypeScript CDK project
echo "🔨 Building the CDK project..."
npm run build

# Bundle the Lambda code with esbuild
echo "📦 Bundling Lambda code with esbuild..."
cd lambda
npm run build
cd ..

# Deploy the stack
echo "🚀 Deploying to AWS..."
# NOTE: deploy script already includes build-lambda, so cdk deploy is sufficient
npx cdk deploy

echo "✅ Deployment completed successfully!"
echo ""
echo "📋 Next steps:"
echo "1. Update the environment variables in lib/klaviyo-signup-stack.ts:"
echo "   - KLAVIYO_API_KEY: Your Klaviyo API key"
echo "   - KLAVIYO_LIST_ID: Your Klaviyo list ID"
echo "   - ALLOWED_ORIGIN: Your signup page domain"
echo "   - API_KEY: A secure API key for authentication"
echo ""
echo "2. Redeploy after updating the configuration:"
echo "   npm run deploy"
echo ""
echo "3. Get your API key from the AWS Console (API Gateway > API Keys)"
echo ""
echo "4. Test the endpoint with the provided API key" 