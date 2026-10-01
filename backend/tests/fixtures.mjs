// Deliberately invented, non-personal amounts. Never use a production export.
export const payload = () => ({
  schemaVersion: 2, month: '2030-01', rate: 5,
  rooms: ['101','102','201','202','301','302'].map((room, i) => ({
    room, prev: 100 + i, curr: '', rent: null, water: null, others: [],
  })), history: [],
});
