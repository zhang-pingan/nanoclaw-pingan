import {
  adoptEvolutionItem,
  approveEvolutionImplementation,
  cancelEvolutionItem,
  pauseEvolutionItem,
  resumeEvolutionItem,
} from './evolution-engine.js';
import type { AssistantEvolutionItemView } from './evolution-store.js';
import type { CardActionResult, InteractiveCard } from '../types.js';

export const ASSISTANT_EVOLUTION_CARD_ACTION = 'assistant_evolution_action';

function actionLabel(action: string): string {
  if (action === 'approve-implementation') return '确认实现';
  if (action === 'adopt') return '采纳方案';
  if (action === 'pause') return '暂停';
  if (action === 'resume') return '继续';
  if (action === 'cancel') return '取消';
  return action;
}

function buildEvolutionActionResult(
  action: string,
  item: AssistantEvolutionItemView,
): CardActionResult {
  const label = actionLabel(action);
  return {
    ok: true,
    toast: {
      type: 'success',
      content: `自我进化已${label}：${item.status}`,
    },
    replacementCard: {
      header: { title: `自我进化：${item.direction}`, color: 'blue' },
      body: [
        `状态：${item.status}`,
        `模块：${item.module_scope || 'unknown'}`,
        `风险：${item.risk_level || 'unknown'}`,
        item.blocked_reason ? `原因：${item.blocked_reason}` : '',
        item.adoption_error ? `采纳错误：${item.adoption_error}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    } satisfies InteractiveCard,
  };
}

export async function handleAssistantEvolutionCardAction(input: {
  itemId: string;
  evolutionAction: string;
}): Promise<CardActionResult> {
  if (!input.itemId) {
    return {
      ok: false,
      toast: { type: 'error', content: '缺少自我进化 item id。' },
    };
  }

  try {
    if (input.evolutionAction === 'approve-implementation') {
      const result = approveEvolutionImplementation(input.itemId);
      return buildEvolutionActionResult(input.evolutionAction, result.item);
    }
    if (input.evolutionAction === 'pause') {
      const result = pauseEvolutionItem(input.itemId);
      return buildEvolutionActionResult(input.evolutionAction, result.item);
    }
    if (input.evolutionAction === 'resume') {
      const result = resumeEvolutionItem(input.itemId);
      return buildEvolutionActionResult(input.evolutionAction, result.item);
    }
    if (input.evolutionAction === 'cancel') {
      const result = cancelEvolutionItem(input.itemId);
      return buildEvolutionActionResult(input.evolutionAction, result.item);
    }
    if (input.evolutionAction === 'adopt') {
      const result = await adoptEvolutionItem(input.itemId);
      return buildEvolutionActionResult(input.evolutionAction, result.item);
    }
    return {
      ok: false,
      toast: { type: 'error', content: '未知自我进化操作。' },
    };
  } catch (err) {
    return {
      ok: false,
      toast: {
        type: 'error',
        content: err instanceof Error ? err.message : '自我进化操作失败。',
      },
    };
  }
}
