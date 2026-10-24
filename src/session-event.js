export const event = (type, payload) => ({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, ...payload } })
