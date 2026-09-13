export { budgetFor } from '@/core/extractor/project';

/**
 * Token budget is not part of the agent boundary.
 *
 * It used to be re-exported from the agent module, which meant the side panel
 * imported that module purely to size an extraction.
 * The budget is a property of the model's context window, not of the agent, so
 * it gets its own door.
 */
