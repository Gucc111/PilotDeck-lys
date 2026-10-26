import express from 'express';
const router = express.Router();
// Keep old clients deterministic. Never resolve a workspace or open old backups.
export function createCheckpointHandler() {
  return async (_req, res) => res.status(410).json({ code: 'CHECKPOINTS_REMOVED', error: 'File checkpoints and restore have been removed. / 文件检查点与恢复功能已移除。' });
}
router.post('/', createCheckpointHandler());
export default router;
