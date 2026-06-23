/**
 * Example: Query Endpoint with Retry Functionality
 * 
 * This example demonstrates how to use the query endpoint with the retry parameter
 * to handle DynamoDB eventual consistency delays.
 * 
 * Note: The query endpoint does not require an API key.
 */

const axios = require('axios');

// Configuration - Update these with your actual values
const API_ENDPOINT = 'https://your-api-id.execute-api.your-region.amazonaws.com/prod/query';

async function querySignupRecord(email, domain, retry = false) {
  try {
    const url = retry ? `${API_ENDPOINT}?retry=true` : API_ENDPOINT;
    
    console.log(`Querying signup record for: ${email} on domain: ${domain}`);
    console.log(`Retry enabled: ${retry}`);
    console.log(`URL: ${url}`);
    
    const response = await axios.post(url, {
      email: email,
      domain: domain
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = response.data;
    
    console.log('Response:', JSON.stringify(result, null, 2));
    
    if (result.found) {
      console.log(`✅ Record found! Subscriber #${result.sequenceNumber} for ${result.domain}`);
      console.log(`   Attempts: ${result.attempts}`);
    } else {
      console.log(`❌ No record found for ${email} on ${domain}`);
      console.log(`   Attempts: ${result.attempts}`);
      console.log(`   Retried: ${result.retried}`);
    }
    
    return result;
    
  } catch (error) {
    console.error('❌ Query failed:', error.response?.data || error.message);
    throw error;
  }
}

async function demonstrateRetryFunctionality() {
  console.log('=== Query Endpoint Retry Functionality Demo ===\n');
  
  const testEmail = 'test@example.com';
  
  // Test 1: Query without retry (immediate response)
  console.log('1. Querying WITHOUT retry (immediate response):');
  try {
    await querySignupRecord(testEmail, 'example.com', false);
  } catch (error) {
    console.log('   Error (expected if no record exists):', error.response?.status);
  }
  
  console.log('\n' + '='.repeat(50) + '\n');
  
  // Test 2: Query with retry (waits up to 5 seconds)
  console.log('2. Querying WITH retry (waits up to 5 seconds):');
  try {
    await querySignupRecord(testEmail, 'example.com', true);
  } catch (error) {
    console.log('   Error (expected if no record exists):', error.response?.status);
  }
  
  console.log('\n' + '='.repeat(50) + '\n');
  
  // Test 3: Query with retry=1 parameter
  console.log('3. Querying with retry=1 parameter:');
  try {
    await querySignupRecord(testEmail, 'example.com', true); // retry=1 is equivalent to retry=true
  } catch (error) {
    console.log('   Error (expected if no record exists):', error.response?.status);
  }
}

// Example usage scenarios
async function exampleScenarios() {
  console.log('\n=== Example Usage Scenarios ===\n');
  
  // Scenario 1: Immediately after signup (might need retry due to eventual consistency)
  console.log('Scenario 1: Query immediately after signup');
  console.log('   Use: retry=true to handle DynamoDB eventual consistency');
  console.log('   Example: POST /query?retry=true');
  console.log('   Behavior: Retries every second for up to 5 seconds\n');
  
  // Scenario 2: Checking existing records (no retry needed)
  console.log('Scenario 2: Check existing records');
  console.log('   Use: No retry parameter (immediate response)');
  console.log('   Example: POST /query');
  console.log('   Behavior: Returns immediately after first database query\n');
  
  // Scenario 3: Real-time applications
  console.log('Scenario 3: Real-time applications');
  console.log('   Use: retry=true for critical queries that must find recent records');
  console.log('   Example: POST /query?retry=true');
  console.log('   Behavior: Ensures eventual consistency doesn\'t cause false negatives\n');
}

// Run the demo if this file is executed directly
if (require.main === module) {
  demonstrateRetryFunctionality()
    .then(() => exampleScenarios())
    .catch(console.error);
}

module.exports = { querySignupRecord }; 