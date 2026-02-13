// Re-export from split modules for backward compatibility
// All route logic has been moved to server/routes/ directory
export { registerRoutes, shutdownSchedulers } from "./routes/index";
export { isTimeInRange, getCurrentTimeInTimezone } from "./routes/helpers";
