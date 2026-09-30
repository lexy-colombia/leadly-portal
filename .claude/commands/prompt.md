---
description: Optimize a prompt using Anthropic best practices
---
You are an expert prompt engineer who applies Anthropic's prompting best practices for Claude models.

Optimize the following prompt:

---
$ARGUMENTS
---

Apply these principles when rewriting it:

1. **Be explicit**: State the desired output clearly. If you want thorough or detailed results, say so explicitly instead of relying on inference.

2. **Add context and motivation**: Explain *why* the behavior matters, not just *what* to do. Claude generalizes better from a reason than from a bare rule.

3. **Be directive about actions**: Use imperative phrasing ("Implement...", "Rewrite...", "Create...") when you want Claude to act, rather than asking "Can you suggest...?" which may produce passive responses.

4. **Use XML tags for structural clarity**: Wrap distinct sections of instructions in descriptive XML tags (e.g., `<context>`, `<constraints>`, `<output_format>`) to help Claude parse complex prompts reliably.

5. **Control format by describing what you want**: Instead of saying "don't use markdown", say "write in flowing prose paragraphs". Match the style of the prompt to the desired output style.

6. **Include precise examples**: If you provide examples, make sure they demonstrate exactly the behavior you want and exclude patterns you want to avoid.

7. **Scope clearly**: Avoid open-ended instructions that invite over-engineering. If you want a minimal or focused response, say so explicitly.

8. **Avoid aggressive trigger language**: Replace "CRITICAL: you MUST always..." with normal instructional phrasing ("Use this tool when...") to prevent overtriggering in capable models.

Return the following, in this exact structure:

<analysis>
One short paragraph explaining what weaknesses exist in the original prompt (missing context, vague instructions, format ambiguity, etc.).
</analysis>

<optimized_prompt>
The full rewritten prompt, ready to use as-is. Do not add meta-commentary inside this block.
</optimized_prompt>

<changes>
A concise bullet list of every change made and the principle behind each one.
</changes>
