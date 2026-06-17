// tests/lib/payload.js

const STATUSES = ['pending', 'completed', 'failed', 'refunded', 'processing'];
const SOURCES  = ['web', 'mobile', 'pos', 'api', 'batch'];

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function generatePayload(count) {
  const records = [];
  for (let i = 0; i < count; i++) {
    records.push({
      id:        uuid(),
      timestamp: new Date(Date.now() - Math.floor(Math.random() * 86400000)).toISOString(),
      amount:    Math.round(Math.random() * 10000) / 100,
      status:    STATUSES[Math.floor(Math.random() * STATUSES.length)],
      source:    SOURCES[Math.floor(Math.random() * SOURCES.length)],
    });
  }
  return records;
}
