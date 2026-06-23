#!/usr/bin/env node

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, ScanCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const crypto = require('crypto');

// Initialize DynamoDB client
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = 'klaviyo-signup';

async function queryByDomain(domain, status = null) {
  const params = {
    TableName: TABLE_NAME,
    IndexName: 'DomainStatusIndex',
    KeyConditionExpression: '#domain = :domain',
    FilterExpression: '#type = :type',
    ExpressionAttributeNames: {
      '#domain': 'domain',
      '#type': 'type'
    },
    ExpressionAttributeValues: {
      ':domain': domain,
      ':type': 'record'
    }
  };

  if (status) {
    params.KeyConditionExpression += ' AND #status = :status';
    params.ExpressionAttributeNames['#status'] = 'status';
    params.ExpressionAttributeValues[':status'] = status;
  }

  try {
    const result = await docClient.send(new QueryCommand(params));
    return result.Items;
  } catch (error) {
    console.error('Error querying by domain:', error);
    throw error;
  }
}

async function queryByStatus(status, limit = 10) {
  const params = {
    TableName: TABLE_NAME,
    IndexName: 'StatusTimestampIndex',
    KeyConditionExpression: '#status = :status',
    FilterExpression: '#type = :type',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#type': 'type'
    },
    ExpressionAttributeValues: {
      ':status': status,
      ':type': 'record'
    },
    ScanIndexForward: false, // Most recent first
    Limit: limit
  };

  try {
    const result = await docClient.send(new QueryCommand(params));
    return result.Items;
  } catch (error) {
    console.error('Error querying by status:', error);
    throw error;
  }
}

async function scanRecentRecords(limit = 20) {
  const params = {
    TableName: TABLE_NAME,
    FilterExpression: '#type = :type',
    ExpressionAttributeNames: {
      '#type': 'type'
    },
    ExpressionAttributeValues: {
      ':type': 'record'
    },
    Limit: limit
  };

  try {
    const result = await docClient.send(new ScanCommand(params));
    return result.Items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (error) {
    console.error('Error scanning records:', error);
    throw error;
  }
}

async function queryByEmail(email) {
  const emailHash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  
  const params = {
    TableName: TABLE_NAME,
    Key: {
      id: emailHash,
      type: 'record'
    }
  };

  try {
    const result = await docClient.send(new GetCommand(params));
    if (result.Item) {
      // Add the email hash to the result for display
      result.Item.email_hash = emailHash;
    }
    return result.Item ? [result.Item] : [];
  } catch (error) {
    console.error('Error querying by email:', error);
    throw error;
  }
}

function displayRecords(records, title) {
  console.log(`\n=== ${title} ===`);
  if (records.length === 0) {
    console.log('No records found.');
    return;
  }

  records.forEach((record, index) => {
    console.log(`${index + 1}. Email Hash: ${record.id.substring(0, 8)}...`);
    console.log(`   Domain: ${record.domain}`);
    console.log(`   Sequence: ${record.sequence_number}`);
    console.log(`   Status: ${record.status}`);
    console.log(`   Timestamp: ${record.timestamp}`);
    if (record.error_message) {
      console.log(`   Error: ${record.error_message}`);
    }
    console.log('');
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'domain':
        const domain = args[1];
        const status = args[2];
        if (!domain) {
          console.log('Usage: node query-signup-records.js domain <domain> [status]');
          process.exit(1);
        }
        const domainRecords = await queryByDomain(domain, status);
        displayRecords(domainRecords, `Records for domain: ${domain}${status ? ` (${status})` : ''}`);
        break;

      case 'status':
        const queryStatus = args[1] || 'error';
        const limit = parseInt(args[2]) || 10;
        const statusRecords = await queryByStatus(queryStatus, limit);
        displayRecords(statusRecords, `Recent ${queryStatus} records (${limit} most recent)`);
        break;

      case 'recent':
        const recentLimit = parseInt(args[1]) || 20;
        const recentRecords = await scanRecentRecords(recentLimit);
        displayRecords(recentRecords, `Recent records (${recentLimit} most recent)`);
        break;

      case 'email':
        const email = args[1];
        if (!email) {
          console.log('Usage: node query-signup-records.js email <email>');
          process.exit(1);
        }
        const emailRecords = await queryByEmail(email);
        displayRecords(emailRecords, `Records for email: ${email}`);
        break;

      default:
        console.log('Usage:');
        console.log('  node query-signup-records.js domain <domain> [status]  - Query by domain and optional status');
        console.log('  node query-signup-records.js status [status] [limit]   - Query by status (default: error)');
        console.log('  node query-signup-records.js recent [limit]            - Show recent records (default: 20)');
        console.log('  node query-signup-records.js email <email>              - Query by email');
        console.log('');
        console.log('Examples:');
        console.log('  node query-signup-records.js domain moviexclusives.com');
        console.log('  node query-signup-records.js domain moviexclusives.com success');
        console.log('  node query-signup-records.js status error 5');
        console.log('  node query-signup-records.js recent 10');
        console.log('  node query-signup-records.js email john@example.com');
    }
  } catch (error) {
    console.error('Script failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  queryByDomain,
  queryByStatus,
  scanRecentRecords,
  queryByEmail
}; 