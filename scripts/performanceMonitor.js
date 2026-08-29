#!/usr/bin/env node

/**
 * Performance Monitoring Script for CRM System
 * This script helps monitor and optimize database performance
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const Lead = require('../models/Lead');
const Client = require('../models/Client');
const Property = require('../models/propertyModel');
const Opportunity = require('../models/Opportunity');

async function connectToDatabase() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  }
}

async function checkIndexes() {
  console.log('\n📊 Checking Database Indexes...');
  
  const collections = [
    { name: 'leads', model: Lead },
    { name: 'clients', model: Client },
    { name: 'properties', model: Property },
    { name: 'opportunities', model: Opportunity }
  ];

  for (const collection of collections) {
    try {
      const indexes = await collection.model.collection.getIndexes();
      console.log(`\n${collection.name.toUpperCase()} Indexes:`);
      Object.keys(indexes).forEach(indexName => {
        console.log(`  - ${indexName}: ${JSON.stringify(indexes[indexName].key)}`);
      });
    } catch (error) {
      console.error(`❌ Error checking indexes for ${collection.name}:`, error.message);
    }
  }
}

async function analyzeCollectionStats() {
  console.log('\n📈 Collection Statistics...');
  
  const collections = [
    { name: 'leads', model: Lead },
    { name: 'clients', model: Client },
    { name: 'properties', model: Property },
    { name: 'opportunities', model: Opportunity }
  ];

  for (const collection of collections) {
    try {
      const count = await collection.model.countDocuments();
      const stats = await collection.model.collection.stats();
      
      console.log(`\n${collection.name.toUpperCase()}:`);
      console.log(`  - Document Count: ${count}`);
      console.log(`  - Average Document Size: ${Math.round(stats.avgObjSize)} bytes`);
      console.log(`  - Total Size: ${Math.round(stats.size / 1024 / 1024 * 100) / 100} MB`);
      console.log(`  - Index Size: ${Math.round(stats.totalIndexSize / 1024 / 1024 * 100) / 100} MB`);
    } catch (error) {
      console.error(`❌ Error analyzing ${collection.name}:`, error.message);
    }
  }
}

async function testQueryPerformance() {
  console.log('\n⚡ Testing Query Performance...');
  
  const testQueries = [
    {
      name: 'Find leads by priority',
      query: () => Lead.find({ priority: 'Hot' }).limit(10)
    },
    {
      name: 'Find clients by city',
      query: () => Client.find({ city: { $exists: true } }).limit(10)
    },
    {
      name: 'Find properties by owner',
      query: () => Property.find({ owner: { $exists: true } }).limit(10)
    },
    {
      name: 'Complex aggregation - Opportunities with populated data',
      query: () => Opportunity.find().populate('client').populate('property').limit(5)
    }
  ];

  for (const test of testQueries) {
    try {
      const startTime = Date.now();
      await test.query();
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      console.log(`  ✅ ${test.name}: ${duration}ms`);
      
      if (duration > 1000) {
        console.log(`    ⚠️  Warning: Query took longer than 1 second`);
      }
    } catch (error) {
      console.log(`  ❌ ${test.name}: Failed - ${error.message}`);
    }
  }
}

async function suggestOptimizations() {
  console.log('\n💡 Performance Optimization Suggestions:');
  
  console.log(`
  1. Database Indexes:
     - Ensure all frequently queried fields have indexes
     - Consider compound indexes for multi-field queries
     - Monitor index usage with db.collection.getIndexes()

  2. Query Optimization:
     - Use .lean() for read-only operations
     - Limit the number of documents returned
     - Use projection to select only needed fields
     - Avoid deep population chains

  3. Connection Pooling:
     - Current maxPoolSize: 10 (good for small-medium apps)
     - Consider increasing for high-traffic applications

  4. Caching:
     - Implement Redis for frequently accessed data
     - Cache user sessions and permissions
     - Cache expensive aggregation results

  5. Frontend Optimizations:
     - Implement debounced search (✅ Done)
     - Use React.memo for expensive components
     - Implement virtual scrolling for large lists
     - Add loading states to prevent multiple clicks (✅ Done)
  `);
}

async function main() {
  console.log('🚀 CRM Performance Monitor Starting...');
  
  await connectToDatabase();
  await checkIndexes();
  await analyzeCollectionStats();
  await testQueryPerformance();
  await suggestOptimizations();
  
  console.log('\n✅ Performance monitoring complete!');
  console.log('\n📝 Next Steps:');
  console.log('1. Monitor your application logs for slow queries');
  console.log('2. Use MongoDB Compass or Atlas for visual performance monitoring');
  console.log('3. Consider implementing caching for frequently accessed data');
  console.log('4. Monitor memory usage and connection pool utilization');
  
  await mongoose.disconnect();
  console.log('\n👋 Disconnected from database');
}

// Run the script
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  connectToDatabase,
  checkIndexes,
  analyzeCollectionStats,
  testQueryPerformance,
  suggestOptimizations
};
