import { Router, type Request } from "express";
import { env } from "../../config/env.js";
import { authUserId, requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../middleware/error.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { createCardBody, fromDocumentBody, idParam, listQuery, reviewBody } from "./flashcards.schema.js";
import * as svc from "./flashcards.service.js";

const router = Router();
router.use(requireAuth);

const idOf = (req: Request) => {
  const p = idParam.safeParse(req.params["id"]);
  if (!p.success) throw new AppError(404, "not_found", "Không tìm thấy.");
  return p.data;
};

router.get("/", async (req, res) => {
  const q = listQuery.parse(req.query);
  res.json(await svc.listCards(authUserId(req), q.due === "true", q.limit));
});
router.post("/", async (req, res) => {
  res.status(201).json(await svc.createCard(authUserId(req), createCardBody.parse(req.body)));
});
router.post(
  "/from-document",
  rateLimit({ windowMs: 3_600_000, max: env.QUIZ_RATE_MAX, key: (r) => r.auth?.userId ?? r.ip ?? "unknown" }),
  async (req, res) => {
    res.status(201).json(await svc.fromDocument(authUserId(req), fromDocumentBody.parse(req.body)));
  },
);
router.post("/from-attempt/:id", async (req, res) => {
  res.status(201).json(await svc.fromAttempt(authUserId(req), idOf(req)));
});
router.post("/:id/review", async (req, res) => {
  res.json(await svc.reviewCard(authUserId(req), idOf(req), reviewBody.parse(req.body).result));
});
router.delete("/:id", async (req, res) => {
  await svc.deleteCard(authUserId(req), idOf(req));
  res.status(204).end();
});

export default router;
