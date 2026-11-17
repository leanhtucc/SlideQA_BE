import { Router } from "express";
import { authUserId, requireAuth } from "../../middleware/auth.js";
import { getStats } from "./stats.service.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  res.json(await getStats(authUserId(req)));
});

export default router;
