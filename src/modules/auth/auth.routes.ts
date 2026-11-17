import { Router } from "express";
import { env } from "../../config/env.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import * as c from "./auth.controller.js";

const router = Router();

router.post("/register", rateLimit({ windowMs: 60_000, max: 20 }), c.register);
router.post("/login", rateLimit({ windowMs: 60_000, max: env.LOGIN_RATE_MAX }), c.login);
router.post("/refresh", rateLimit({ windowMs: 60_000, max: 60 }), c.refresh);
router.post("/forgot", rateLimit({ windowMs: 3_600_000, max: env.RESET_RATE_MAX }), c.forgot);
router.post("/reset", rateLimit({ windowMs: 60_000, max: 10 }), c.reset);
router.post("/logout", c.logout);

export default router;
