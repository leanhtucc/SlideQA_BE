import { Router } from "express";
import { authUserId, requireAuth } from "../../middleware/auth.js";
import { changePasswordBody, deleteAccountBody, profileBody } from "../auth/auth.schema.js";
import { changePassword, deleteAccount, getUser, updateProfile } from "../auth/auth.service.js";
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
router.patch("/me", requireAuth, async (req, res) => {
  res.json(await updateProfile(authUserId(req), profileBody.parse(req.body).displayName));
});
// Đổi mật khẩu thu hồi mọi phiên; web đưa người dùng về trang đăng nhập.
router.post("/me/password", requireAuth, async (req, res) => {
  const b = changePasswordBody.parse(req.body);
  await changePassword(authUserId(req), b.currentPassword, b.newPassword);
  res.status(204).end();
});
router.delete("/me", requireAuth, async (req, res) => {
  await deleteAccount(authUserId(req), deleteAccountBody.parse(req.body));
  res.status(204).end();
});

export default router;
