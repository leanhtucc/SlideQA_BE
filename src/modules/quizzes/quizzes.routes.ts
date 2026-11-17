import { Router, type Request } from "express";
import { env } from "../../config/env.js";
import { authUserId, requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../middleware/error.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { answerBody, createQuizBody, flagBody, idParam } from "./quizzes.schema.js";
import * as svc from "./quizzes.service.js";

const id = (req: Request, name = "id") => {
  const p = idParam.safeParse(req.params[name]);
  if (!p.success) throw new AppError(404, "not_found", "Không tìm thấy.");
  return p.data;
};

/** /api/v1/quizzes */
export const quizzesRouter = Router();
quizzesRouter.use(requireAuth);

quizzesRouter.post(
  "/",
  rateLimit({ windowMs: 3_600_000, max: env.QUIZ_RATE_MAX, key: (r) => r.auth?.userId ?? r.ip ?? "unknown" }),
  async (req, res) => {
    res.status(201).json(await svc.createQuiz(authUserId(req), createQuizBody.parse(req.body)));
  },
);
quizzesRouter.get("/", async (req, res) => {
  res.json(await svc.listQuizzes(authUserId(req)));
});
quizzesRouter.get("/:id", async (req, res) => {
  res.json(await svc.getQuiz(authUserId(req), id(req)));
});
quizzesRouter.put("/:id/items/:itemId/flag", async (req, res) => {
  res.json(await svc.flagItem(authUserId(req), id(req), id(req, "itemId"), flagBody.parse(req.body).flagged));
});
quizzesRouter.post("/:id/attempts", async (req, res) => {
  const { created, attempt } = await svc.startAttempt(authUserId(req), id(req));
  res.status(created ? 201 : 200).json(attempt);
});

/** /api/v1/attempts */
export const attemptsRouter = Router();
attemptsRouter.use(requireAuth);

attemptsRouter.get("/:id", async (req, res) => {
  res.json(await svc.getAttempt(authUserId(req), id(req)));
});
attemptsRouter.put("/:id/answers/:itemId", async (req, res) => {
  res.json(await svc.answer(authUserId(req), id(req), id(req, "itemId"), answerBody.parse(req.body).chosenIndex));
});
attemptsRouter.post("/:id/finish", async (req, res) => {
  res.json(await svc.finishAttempt(authUserId(req), id(req)));
});
attemptsRouter.post("/:id/retry-wrong", async (req, res) => {
  res.status(201).json(await svc.retryWrong(authUserId(req), id(req)));
});
