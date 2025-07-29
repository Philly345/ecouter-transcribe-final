import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kilo';
console.log('MongoDB URI:', uri); // Temporary debug log

let client;
let clientPromise;

if (!global._mongoClientPromise) {
  client = new MongoClient(uri);
  global._mongoClientPromise = client.connect();
}

clientPromise = global._mongoClientPromise;

export async function connectDB() {
  const client = await clientPromise;
  const db = client.db();
  return { client, db };
}

export async function connectToDatabase() {
  return connectDB();
}
