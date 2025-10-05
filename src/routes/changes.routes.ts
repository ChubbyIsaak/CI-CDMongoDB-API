import { Router } from "express";
import {
  applyBatchController,
  applyChangeController,
  getChangeController,
  listPendingController,
  revertChangeController,
} from "../controllers/changes.controller";
import { windowGuard } from "../middleware/windowGuard";
import { verifySignature } from "../middleware/signature";
import { limiter } from "../middleware/rateLimit";

export const router = Router();

// Write endpoints: signature -> rate limit -> window guard
router.post("/apply", verifySignature(), limiter(), windowGuard(), applyChangeController);
router.post("/apply-batch", verifySignature(), limiter(), windowGuard(), applyBatchController);
router.post("/revert", verifySignature(), limiter(), revertChangeController);

// Read endpoints
router.get("/:changeId", getChangeController);
router.get("/", listPendingController);
router.get("/pending", listPendingController);
