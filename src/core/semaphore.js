/**
 * Simple Semaphore implementation for Cloudflare Workers
 * A lightweight alternative to async-sema that doesn't require Node.js built-ins
 */

export class Semaphore {
  constructor(maxConcurrency = 1) {
    this.maxConcurrency = maxConcurrency;
    this.currentCount = 0;
    this.waitingQueue = [];
  }

  /**
   * Acquire a semaphore permit
   * @returns {Promise<Function>} Release function
   */
  async acquire() {
    return new Promise((resolve) => {
      if (this.currentCount < this.maxConcurrency) {
        // Permit available immediately
        this.currentCount++;
        resolve(() => this.release());
      } else {
        // Add to waiting queue
        this.waitingQueue.push(resolve);
      }
    });
  }

  /**
   * Release a semaphore permit
   */
  release() {
    if (this.waitingQueue.length > 0) {
      // Wake up next waiting task
      const nextResolve = this.waitingQueue.shift();
      nextResolve(() => this.release());
    } else {
      // No one waiting, just decrement count
      this.currentCount--;
    }
  }

  /**
   * Try to acquire without waiting
   * @returns {Function|null} Release function or null if not available
   */
  tryAcquire() {
    if (this.currentCount < this.maxConcurrency) {
      this.currentCount++;
      return () => this.release();
    }
    return null;
  }

  /**
   * Get number of tasks waiting for permits
   * @returns {number}
   */
  get waiting() {
    return this.waitingQueue.length;
  }

  /**
   * Get number of available permits
   * @returns {number}
   */
  get available() {
    return this.maxConcurrency - this.currentCount;
  }

  /**
   * Get number of permits currently in use
   * @returns {number}
   */
  get active() {
    return this.currentCount;
  }
}

/**
 * Simple Rate Limiter implementation for Cloudflare Workers
 * Limits calls per time window with uniform distribution
 */
export class RateLimiter {
  constructor(maxRequests, timeWindow = 1000, uniformDistribution = true) {
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
    this.uniformDistribution = uniformDistribution;
    this.requests = [];
    this.lastReset = Date.now();
  }

  /**
   * Wait for rate limit clearance
   * @returns {Promise<void>}
   */
  async acquire() {
    const now = Date.now();
    
    // Reset window if needed
    if (now - this.lastReset >= this.timeWindow) {
      this.requests = [];
      this.lastReset = now;
    }

    // Filter out old requests
    this.requests = this.requests.filter(time => now - time < this.timeWindow);

    if (this.requests.length < this.maxRequests) {
      // Add this request timestamp
      this.requests.push(now);
      return;
    }

    // Need to wait
    if (this.uniformDistribution) {
      // Uniform distribution: spread requests evenly
      const timePerRequest = this.timeWindow / this.maxRequests;
      const lastRequest = this.requests[this.requests.length - 1];
      const nextAllowedTime = lastRequest + timePerRequest;
      const waitTime = Math.max(0, nextAllowedTime - now);
      
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    } else {
      // Burst mode: wait until oldest request expires
      const oldestRequest = this.requests[0];
      const waitTime = Math.max(0, (oldestRequest + this.timeWindow) - now);
      
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    // Add this request after waiting
    this.requests.push(Date.now());
  }

  /**
   * Reset the rate limiter
   */
  reset() {
    this.requests = [];
    this.lastReset = Date.now();
  }
}

/**
 * Factory function for creating rate limiters (similar to async-sema API)
 * @param {number} rps - Requests per second
 * @param {Object} options - Options object
 * @returns {Function} Rate limiter function
 */
export function createRateLimit(rps, options = {}) {
  const timeUnit = options.timeUnit || 1000;
  const uniformDistribution = options.uniformDistribution !== false;
  
  const rateLimiter = new RateLimiter(rps, timeUnit, uniformDistribution);
  
  return () => rateLimiter.acquire();
} 