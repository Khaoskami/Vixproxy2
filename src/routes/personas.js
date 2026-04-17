import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/security.js';
import { supabase } from '../models/supabase.js';

const router = Router();
router.use(requireAuth);

function valErr(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Validation failed', details: errors.array().map((e) => e.msg) });
    return true;
  }
  return false;
}

// GET /api/personas
router.get('/', async (req, res) => {
  const { data: personas, error } = await supabase
    .from('vk_personas')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to fetch personas' });
  res.json({ personas });
});

// GET /api/personas/community
router.get('/community', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const { data, error } = await supabase
    .from('vk_personas')
    .select('id, name, system_prompt, model, created_at, vk_users!inner(username)')
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: 'Failed to fetch community personas' });

  const personas = (data || []).map((p) => ({
    id: p.id,
    name: p.name,
    system_prompt: p.system_prompt,
    model: p.model,
    created_at: p.created_at,
    author: p.vk_users?.username || 'unknown',
  }));
  res.json({ personas });
});

// POST /api/personas
router.post(
  '/',
  [
    body('name').trim().isLength({ min: 1, max: 100 }),
    body('systemPrompt').isLength({ min: 1, max: 8000 }),
    body('model').optional().isLength({ max: 128 }),
    body('temperature').optional().isFloat({ min: 0, max: 2 }),
    body('maxTokens').optional().isInt({ min: 1, max: 32000 }),
    body('isPublic').optional().isBoolean(),
  ],
  async (req, res) => {
    if (valErr(req, res)) return;
    const { data, error } = await supabase
      .from('vk_personas')
      .insert({
        user_id: req.user.id,
        name: req.body.name,
        system_prompt: req.body.systemPrompt,
        model: req.body.model || 'openai/gpt-4o',
        temperature: req.body.temperature ?? 0.8,
        max_tokens: req.body.maxTokens ?? 2048,
        is_public: req.body.isPublic ?? false,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: 'Failed to create persona' });
    res.status(201).json({ message: 'Persona created', persona: data });
  },
);

// DELETE /api/personas/:id
router.delete('/:id', [param('id').isUUID()], async (req, res) => {
  if (valErr(req, res)) return;
  const { error } = await supabase
    .from('vk_personas')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: 'Failed to delete persona' });
  res.json({ message: 'Persona deleted' });
});

export default router;
