import { Router, type Request } from "express";
import { AppError } from "../../middleware/error.js";
import { authUserId, requireAuth } from "../../middleware/auth.js";
import { courseId, createCourseBody, updateCourseBody } from "./courses.schema.js";
import * as svc from "./courses.service.js";

const router = Router();
router.use(requireAuth);

const idOf = (req: Request) => {
  const p = courseId.safeParse(req.params["id"]);
  if (!p.success) throw new AppError(404, "not_found", "Không tìm thấy môn học.");
  return p.data;
};

router.get("/", async (req, res) => {
  res.json(await svc.listCourses(authUserId(req)));
});

router.post("/", async (req, res) => {
  res.status(201).json(await svc.createCourse(authUserId(req), createCourseBody.parse(req.body)));
});

router.get("/:id", async (req, res) => {
  res.json(await svc.getCourse(authUserId(req), idOf(req)));
});

router.patch("/:id", async (req, res) => {
  res.json(await svc.updateCourse(authUserId(req), idOf(req), updateCourseBody.parse(req.body)));
});

router.delete("/:id", async (req, res) => {
  await svc.deleteCourse(authUserId(req), idOf(req));
  res.status(204).end();
});

export default router;
