export const MAX_BODY_BYTES = 512 * 1024;
const ROOM_IDS = ['101', '102', '201', '202', '301', '302'];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const month = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
function validRooms(rooms: unknown): boolean {
  if (!Array.isArray(rooms) || rooms.length !== 6) return false;
  if (new Set(rooms.map(r => object(r) ? r.room : null)).size !== 6) return false;
  return rooms.every(r => object(r) && typeof r.room === 'string' && ROOM_IDS.includes(r.room)
    && finite(r.prev, 0, 1e10)
    && (r.curr === '' || ((typeof r.curr === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(r.curr)) || typeof r.curr === 'number') && finite(Number(r.curr), 0, 1e10))
    && (r.rent === null || finite(r.rent, 0, 1e8))
    && (r.water === null || finite(r.water, 0, 1e8))
    && Array.isArray(r.others) && r.others.length <= 100
    && r.others.every(o => object(o) && typeof o.name === 'string' && o.name.length <= 200 && finite(o.amount, -1e8, 1e8)));
}
// Validate without normalization: do not silently change archived bills or a
// verified source baseline. Extra historical calculation fields are preserved.
export function validPayload(value: unknown): value is Record<string, unknown> {
  return object(value) && value.schemaVersion === 2 && month(value.month)
    && finite(value.rate, 0, 10000) && validRooms(value.rooms)
    && Array.isArray(value.history) && value.history.length <= 1200
    && value.history.every(h => object(h) && month(h.month) && finite(h.rate, 0, 10000) && validRooms(h.rooms));
}
export function validWrite(body: unknown): body is {payload: Record<string, unknown>; expected_revision: number; actor: string; mutation_id: string} {
  return object(body) && validPayload(body.payload)
    && Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 1
    && typeof body.actor === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(body.actor)
    && typeof body.mutation_id === 'string' && /^[A-Za-z0-9_-]{16,120}$/.test(body.mutation_id);
}
