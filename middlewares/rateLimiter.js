const rateLimit = require('express-rate-limit');

// Rate limiting middleware for API endpoints
const createRateLimit = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      error: message || 'Too many requests, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip successful requests
    skipSuccessfulRequests: false,
    // Skip failed requests
    skipFailedRequests: false,
  });
};

// Different rate limits for different operations
const apiLimiter = createRateLimit(1 * 60 * 1000, 500, 'Too many API requests'); // 100 requests per 15 minutes
const createLimiter = createRateLimit(60 * 1000, 20, 'Too many creation requests'); // 5 requests per minute
const authLimiter = createRateLimit(1 * 60 * 1000, 10, 'Too many authentication attempts'); // 5 requests per 15 minutes

module.exports = {
  apiLimiter,
  createLimiter,
  authLimiter
};


