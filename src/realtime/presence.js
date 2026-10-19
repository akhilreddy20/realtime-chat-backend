/**
 * Tracks which sockets belong to which user.
 *
 * A user can have several sockets at once (two tabs, phone + laptop). The
 * original code stored one socket id per user, so opening a second tab
 * silently stopped delivery to the first, and closing either tab marked the
 * user offline. Here a user is online while they have at least one socket.
 */
export class PresenceRegistry {
  constructor() {
    this.socketsByUser = new Map(); // userId -> Set<socketId>
  }

  /** @returns {boolean} true if this is the user's first socket (they just came online) */
  add(userId, socketId) {
    const key = String(userId);
    let sockets = this.socketsByUser.get(key);
    const cameOnline = !sockets;
    if (!sockets) {
      sockets = new Set();
      this.socketsByUser.set(key, sockets);
    }
    sockets.add(socketId);
    return cameOnline;
  }

  /** @returns {boolean} true if that was the user's last socket (they went offline) */
  remove(userId, socketId) {
    const key = String(userId);
    const sockets = this.socketsByUser.get(key);
    if (!sockets) return false;
    sockets.delete(socketId);
    if (sockets.size === 0) {
      this.socketsByUser.delete(key);
      return true;
    }
    return false;
  }

  isOnline(userId) {
    return this.socketsByUser.has(String(userId));
  }

  onlineUserIds() {
    return [...this.socketsByUser.keys()];
  }
}
