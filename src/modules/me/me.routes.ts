import { Router } from "express";
import { authUserId, requireAuth } from "../../middleware/auth.js";
import { getUser } from "../auth/auth.service.js";

const router = Router();

router.get("/me", requireAuth, async (req, res) => {
  res.json(await getUser(authUserId(req)));
});
// PATCH /me, DELETE /me: lát E1.

export default router;
