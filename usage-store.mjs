import { randomUUID } from 'node:crypto';

export const newEvent = (id, label, limit = 10, sessionLimit = 2) => ({
  _id: 'active', eventId: id, label, enabled: false, limit, sessionLimit,
  used: 0, requests: [], leaseUntil: new Date(0), leaseOwner: null, createdAt: new Date(),
});
export function publicStatus(state) {
  return { eventId: state.eventId, label: state.label, enabled: state.enabled,
    used: state.used, limit: state.limit, sessionLimit: state.sessionLimit,
    remaining: Math.max(0, state.limit - state.used), busy: new Date(state.leaseUntil) > new Date(),
    model: 'gpt-image-2', quality: 'medium' };
}
export function reservationFilter(eventId, session, requestId, now) {
  return {
    _id: 'active', eventId, enabled: true, leaseUntil: { $lte: now }, 'requests.id': { $ne: requestId },
    $expr: { $and: [
      { $lt: ['$used', '$limit'] },
      { $lt: [ { $size: { $filter: { input: '$requests', as: 'r', cond: { $eq: ['$$r.session', session] } } } }, '$sessionLimit' ] },
    ] },
  };
}
export class MongoUsageStore {
  constructor(collection) { this.collection = collection; }
  async init() {
    await this.collection.updateOne({ _id: 'active' }, { $setOnInsert: newEvent(randomUUID(), 'Premier test en ligne') }, { upsert: true });
  }
  async status() {
    const state = await this.collection.findOne({ _id: 'active' });
    if (!state || !Array.isArray(state.requests) || !Number.isInteger(state.used) || !Number.isInteger(state.limit)) throw new Error('CounterUnavailable');
    return state;
  }
  async reserve(eventId, session, requestId, hash) {
    const now = new Date();
    return this.collection.findOneAndUpdate(reservationFilter(eventId, session, requestId, now), {
      $inc: { used: 1 },
      $set: { leaseUntil: new Date(now.getTime() + 240_000), leaseOwner: requestId },
      $push: { requests: { id: requestId, session, hash, status: 'started', at: now } },
    }, { returnDocument: 'after', includeResultMetadata: false });
  }
  async finish(eventId, requestId, status) {
    await this.collection.updateOne({ _id: 'active', eventId, leaseOwner: requestId }, {
      $set: { leaseUntil: new Date(0), leaseOwner: null, 'requests.$[r].status': status },
    }, { arrayFilters: [{ 'r.id': requestId }] });
  }
  async configure(eventId, values) {
    return this.collection.findOneAndUpdate({ _id: 'active', eventId }, { $set: values }, { returnDocument: 'after', includeResultMetadata: false });
  }
  async startEvent(id, label, limit, sessionLimit) {
    const current = await this.status();
    if (current.eventId === id) return current; // même confirmation envoyée deux fois
    const now = new Date();
    if (new Date(current.leaseUntil) > now) return null;
    const archive = { ...current, _id: 'event-' + current.eventId, archivedAt: now };
    await this.collection.replaceOne({ _id: archive._id }, archive, { upsert: true });
    return this.collection.findOneAndReplace({ _id: 'active', eventId: current.eventId, used: current.used, leaseUntil: { $lte: now } },
      newEvent(id, label, limit, sessionLimit), { returnDocument: 'after', includeResultMetadata: false });
  }
}
