import { Router, type Request } from "express";
import { env } from "../../config/env.js";
import { authUserId, requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../middleware/error.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { askBody, createConversationBody, feedbackBody, idParam, listQuery, renameBody } from "./conversations.schema.js";
import * as svc from "./conversations.service.js";

const router = Router();
router.use(requireAuth);

const idOf = (req: Request) => {
  const p = idParam.safeParse(req.params["id"]);
  if (!p.success) throw new AppError(404, "not_found", "Không tìm thấy hội thoại.");
  return p.data;
};

router.post("/", async (req, res) => {
  res.status(201).json(await svc.createConversation(authUserId(req), createConversationBody.parse(req.body)));
});

router.get("/", async (req, res) => {
  const q = listQuery.parse(req.query);
  res.json(await svc.listConversations(authUserId(req), q.q, q.limit));
});

router.get("/:id", async (req, res) => {
  res.json(await svc.getConversation(authUserId(req), idOf(req)));
});

router.patch("/:id", async (req, res) => {
  res.json(await svc.renameConversation(authUserId(req), idOf(req), renameBody.parse(req.body).title));
});

router.delete("/:id", async (req, res) => {
  await svc.deleteConversation(authUserId(req), idOf(req));
  res.status(204).end();
});

// 30 lượt hỏi mỗi giờ mỗi người dùng (NFR-09); khóa theo userId, không theo IP.
router.post(
  "/:id/messages",
  rateLimit({ windowMs: 3_600_000, max: env.ASK_RATE_MAX, key: (r) => r.auth?.userId ?? r.ip ?? "unknown" }),
  async (req, res) => {
    res.json(await svc.ask(authUserId(req), idOf(req), askBody.parse(req.body).question));
  },
);

router.put("/:id/messages/:messageId/feedback", async (req, res) => {
  const m = idParam.safeParse(req.params["messageId"]);
  if (!m.success) throw new AppError(404, "not_found", "Không tìm thấy câu trả lời.");
  res.json(await svc.setFeedback(authUserId(req), idOf(req), m.data, feedbackBody.parse(req.body).value));
});

export default router;
