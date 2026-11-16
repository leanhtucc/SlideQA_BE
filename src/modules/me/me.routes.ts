import { Router } from "express";
import { authUserId, requireAuth } from "../../middleware/auth.js";
import { getUser } from "../auth/auth.service.js";
import { consentBody } from "../conversations/conversations.schema.js";
import { setLlmConsent } from "../conversations/conversations.service.js";

const router = Router();

router.get("/me", requireAuth, async (req, res) => {
  res.json(await getUser(authUserId(req)));
});
// Đồng ý (hoặc rút lại) việc gửi đoạn tài liệu liên quan cho nhà cung cấp AI (FR-SET-01).
router.put("/me/llm-consent", requireAuth, async (req, res) => {
  res.json(await setLlmConsent(authUserId(req), consentBody.parse(req.body).granted));
});
// PATCH /me, DELETE /me: lát E1.

export default router;
