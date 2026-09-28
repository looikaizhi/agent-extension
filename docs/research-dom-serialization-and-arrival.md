# 别人怎么序列化页面、怎么逼模型判断「已经到了」——一手来源摘录

> 本文是**原始素材**，不是设计方案。它只做两件事：把 browser-use、Playwright MCP、WebVoyager、Mind2Web 的相关源码与论文原文抄下来并标注出处；把「原文说了什么」和「我从原文推出了什么」严格分开。全文不给任何实现建议——凡是读起来像「我们应该…」的句子都不应该出现在这里。
>
> 所有代码引用都带 `仓库@commit 路径:行号`，可复现。所有论文引用都带章节号。二手博客、教程、总结一律不采用。

---

## 0. 一手来源清单（读的是哪个版本）

| 来源 | 版本 / commit | 日期 | 备注 |
|---|---|---|---|
| browser-use | `d5453ae80e11d61c94986d3506d37a829b473c42`，`pyproject.toml` 声明 `version = "0.13.10"` | 2026-09-04 | 本文简写 `browser-use@d5453ae` |
| playwright-mcp | `8a13ef8e9f7385a0f89477922127f31cbfde9761`，`package.json` 声明 `"version": "0.0.80"` | 2026-09-03 | 该仓库 `src/README.md` 原文：「Playwright MCP source code is located in the [Playwright monorepo](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp).」——实现已迁走 |
| playwright monorepo | `46cd5008d12d4e1297793d921e6cc3b595e388da` | 2026-09-04 | 本文简写 `playwright@46cd500`；MCP 的真实实现在这里 |
| WebVoyager | `5a7896738c10bfb8b9edccce6bb0e0411f8ae569` | 2024-03-04 | 论文 arXiv:2401.13919 v4（2024-06-06），ACL 2024 main |
| Mind2Web | `33bd95caeee7bba22dd08ecc935845e15c5e5dc7` | 2025-11-04 | 论文 arXiv:2306.06070 v3（2023-12-09），NeurIPS'23 Spotlight |
| browser-use 历史版本 | tag `0.1.40` | — | 只用于确认一个已被删除的机制（§3.4.1） |

本项目侧的对照基准读的是 `src/core/extractor/project.ts`（`prune` 在 155-170 行，`score` 在 182-190 行，`toPromptText` 在 354-389 行）与 `src/agent/guide/agent.ts`（`outputSchema`）。本文不修改这两个文件。

---

## 1. 先给结论

只列可被下面每一节的原文直接支撑的事实对比，不做评价。

1. **四个被查的框架里，只有一个按「与目标的相关性」剪枝，而它靠的是一个单独训练的小模型，不是打分规则。** 那是 Mind2Web 的 MindAct：用 DeBERTa cross-encoder 把 `task is: {任务}\nPrevious actions: ...` 和每个候选元素配对打分，取 top-50（§2.4）。browser-use 与 Playwright MCP 的所有过滤规则都与目标无关；本项目的 `score()` 也与目标无关。
2. **browser-use 的「上限」是 40000 个**字符**，超了就直接从尾部切断**，并在标题里写明 `(truncated to 40000 characters)`；它没有任何元素条数上限，也不做打分排序（§2.1.1）。本项目的上限是 150 个**元素**，靠打分决定谁先被砍。
3. **browser-use 的视口过滤是硬过滤，不是偏好**：视口上下各 `1000` 像素以外的元素直接 `is_visible = False`，连进入序列化树的机会都没有；作为补偿它在提示里写 `<page_info>N pages above, M pages below</page_info>`、`[Start of page]` / `[End of page]`，并在系统提示里明说「By default, only elements in the visible viewport are listed.」（§2.1.2、§2.1.3）。本项目的视口是打分项而非过滤器（`project.ts:172-190` 的注释明确写了这一点）。
4. **Playwright MCP 完全不剪枝、不设上限、没有视口概念**：`ai` 模式的 `visibility` 是 `'ariaOrVisible'`，`visible` 的定义是 `rect.width > 0 && rect.height > 0`（渲染出来即可，与滚动位置无关）。它的「蒸馏」明确写着 "without losing information"。快照大到装不下时，它的做法是**写文件 + `find` 搜索 + `--depth` 截断层级**，不是选择性丢弃元素（§2.2）。
5. **Playwright MCP 没有 scroll 工具**（工具全表见 §2.2.4）。browser-use、WebVoyager 都把 scroll 作为动作交给模型。
6. **browser-use 的 `done` 是动作列表里的一个普通 action，和 `click`、`scroll` 平级**，但它有一个 `success: bool` 自评字段，并且整个输出的 schema 强制 `required = ['evaluation_previous_goal', 'memory', 'next_goal', 'action']`——**三个反思字段是每一步必填的，且在 schema 里排在 `action` 之前**（§3.1、§3.2）。
7. **browser-use 的 Pydantic 模型上这三个字段一个 `description` 都没有**，语义全部写在 `system_prompt.md` 里（§3.1）。本项目相反：语义写在 tool schema 的 `description` 上。
8. **browser-use 曾经有过一个专门判断「是否真的做完」的独立模型调用**（`_validate_output`，默认关闭），在当前版本已被删除，换成了一个**事后**的 `judge`，且代码注释明说 judge 的结论「does NOT override last_result.success」（§3.4.1）。

---

## 2. 问题一：别的框架怎么解析 / 序列化页面

### 2.1 browser-use

#### 2.1.1 是否剪枝？有没有硬上限？

**读到的原文。** 唯一的整体上限是字符数，且是尾部直接切片：

`browser-use@d5453ae browser_use/agent/prompts.py:252-258`

```python
elements_text = self.browser_state.dom_state.llm_representation(include_attributes=self.include_attributes)

if len(elements_text) > self.max_clickable_elements_length:
    elements_text = elements_text[: self.max_clickable_elements_length]
    truncated_text = f' (truncated to {self.max_clickable_elements_length} characters)'
else:
    truncated_text = ''
```

默认值 `40000`，在三处独立声明：

- `browser_use/agent/prompts.py:117` — `max_clickable_elements_length: int = 40000,`
- `browser_use/agent/service.py:210` — `max_clickable_elements_length: int = 40000,`
- `browser_use/beta/service.py:4299` — `max_clickable_elements_length: int = 40000,`

被截断这件事会写进给模型的段落标题里：

`browser_use/agent/prompts.py:332`

```python
{state_error_text}{recent_events_text}{closed_popups_text}{pdf_message}Interactive elements{truncated_text}:
```

序列化器本身（`browser_use/dom/serializer/serializer.py`）里没有任何元素条数上限。该文件里所有 `MAX_*` 常量只有三个，全部与图片上下文有关（`serializer.py:59-61`）：

```python
MAX_CHILD_IMAGE_CONTEXTS = 3
MAX_CHILD_IMAGE_DESCENDANTS = 100
MAX_IMAGE_CONTEXT_ATTRIBUTE_LENGTH = 4096
```

**我的推断。** 40000 字符的尾部切片，切掉的是**文档顺序上最靠后的部分**，也就是页面底部；而不是「最不相关的部分」。这与「按分数排序后取 top-N，再恢复文档顺序」（本项目 `project.ts:163-168`）是两种不同的丢弃语义：前者丢弃的位置可预测（永远是尾部），后者丢弃的位置随滚动位置漂移。

#### 2.1.2 如果剪枝，按什么规则？有没有导航 / landmark 的保底或加权？

**读到的原文。** 在元素进入序列化树**之前**，有一道视口硬过滤。函数签名与文档字符串：

`browser-use@d5453ae browser_use/dom/service.py:252-262`

```python
def is_element_visible_according_to_all_parents(
    cls, node: EnhancedDOMTreeNode, html_frames: list[EnhancedDOMTreeNode], viewport_threshold: int | None = 1000
) -> bool:
    """Check if the element is visible according to all its parent HTML frames.

    Args:
        node: The DOM node to check visibility for
        html_frames: List of parent HTML frame nodes
        viewport_threshold: Pixel threshold beyond viewport to consider visible.
            Default 1000px. Set to None to disable threshold checking entirely.
    """
```

阈值只作用在**纵向**，横向必须真正相交：

`browser_use/dom/service.py:337-346`

```python
frame_intersects = (
    adjusted_x < viewport_right
    and adjusted_x + current_bounds.width > viewport_left
    and adjusted_y < viewport_bottom + viewport_threshold
    and adjusted_y + current_bounds.height > viewport_top - viewport_threshold
)

if not frame_intersects:
    return False
```

默认值 `1000` 在 `DomService.__init__` 里（`browser_use/dom/service.py:64`：`viewport_threshold: int | None = 1000,`），调用点在 `browser_use/dom/service.py:952-954`：

```python
dom_tree_node.is_visible = self.is_element_visible_according_to_all_parents(
    dom_tree_node, updated_html_frames, self.viewport_threshold
)
```

而 `is_visible` 决定该节点是否进入简化树（`browser_use/dom/serializer/serializer.py:512`、`:533-534`）：

```python
is_visible = node.is_visible
...
# Include if visible, scrollable, has children, or is shadow host
if is_visible or is_scrollable or has_shadow_content or is_shadow_host:
```

`is_visible` 有两条**成文的例外**，也是这份代码里仅有的两条「保底」，都与角色/导航无关：

`browser_use/dom/serializer/serializer.py:519-531`

```python
# Override visibility for elements with validation attributes
if not is_visible and node.attributes:
    has_validation_attrs = any(attr.startswith(('aria-', 'pseudo')) for attr in node.attributes.keys())
    if has_validation_attrs:
        is_visible = True  # Force visibility for validation elements

# EXCEPTION: File inputs are often hidden with opacity:0 but are still functional
# Bootstrap and other frameworks use this pattern with custom-styled file pickers
is_file_input = (
    node.tag_name and node.tag_name.lower() == 'input' and node.attributes and node.attributes.get('type') == 'file'
)
if not is_visible and is_file_input:
    is_visible = True  # Force visibility for file inputs
```

进入树之后还有两道**几何**过滤，同样与目标无关：

1. **paint order**（`serializer.py:134-137`，`PaintOrderRemover`）——被盖住的元素去掉。
2. **bounding box containment**（`serializer.py:772-786`、`831-882`）——完全落在某个「传播型」父元素框内的子元素被标为 `excluded_by_parent`。阈值常量在 `serializer.py:58`：`DEFAULT_CONTAINMENT_THRESHOLD = 0.99  # 99% containment by default`。它的例外清单是：

```python
# 1. Never exclude form elements (they need individual interaction)
if child_tag in ['input', 'select', 'textarea', 'label']:
    return False
```

（`serializer.py:854-856`）

`PROPAGATING_ELEMENTS` 的定义（`serializer.py:46-57`）是 `a` / `button` / `div[role=button]` / `div[role=combobox]` / `span[role=button]` / `span[role=combobox]` / `input[role=combobox]`。

**没有查到任何按角色加权、按 landmark 保底、或按目标相关性打分的代码。** 我在 `browser_use/dom/` 全目录 grep 过 `score`、`rank`、`relevance`、`budget`、`priority`，只命中了与图片上下文和 paint order 有关的实现。

**我的推断。** browser-use 的取舍是「先用一个与目标无关的**硬**几何规则把集合缩到视口 ±1000px，再用字符预算兜底」。它没有排序，所以也不存在「导航项因为分数低被排到 150 名之后」这一类失败模式；它的对应失败模式是「导航项因为滚出了视口 ±1000px 而**整个消失**」。这两种失败模式的可观测表现不同：前者是元素静默缺席且顺序不变，后者也是静默缺席——但 browser-use 用 §2.1.3 里的 `<page_info>` / `[Start of page]` / `[End of page]` / 系统提示第 75 行三处，把「你看到的只是视口」这件事说了出来。

#### 2.1.3 序列化格式

**读到的原文。** 是**带缩进的树**，不是扁平编号表。格式的权威描述在系统提示里，而且带一个完整示例：

`browser-use@d5453ae browser_use/agent/system_prompts/system_prompt.md:40-63`

```
<browser_state>
1. Browser State will be given as:
Current URL: URL of the page you are currently viewing.
Open Tabs: Open tabs with their ids.
Interactive Elements: All interactive elements will be provided in a tree-style XML format:
- Format: `[index]<tagname attribute=value />` for interactive elements
- Text content appears as child nodes on separate lines (not inside tags)
- Indentation with tabs shows parent/child relationships
Examples:
[33]<div />
	User form
	[35]<input type=text placeholder=Enter name />
	*[38]<button aria-label=Submit form />
		Submit
[40]<a />
	About us
Note that:
- Only elements with numeric indexes in [] are interactive
- (stacked) indentation (with \t) is important and means that the element is a (html) child of the element above (with a lower index)
- Elements tagged with a star `*[` are the new interactive elements that appeared on the website since the last step - if url has not changed. Your previous actions caused that change. Think if you need to interact with them, e.g. after input you might need to select the right option from the list.
- Pure text elements without [] are not interactive
- `|SCROLL|` prefix indicates scrollable containers with scroll position info
- `|SHADOW(open)|` or `|SHADOW(closed)|` prefix indicates shadow DOM elements
</browser_state>
```

（注：系统提示写的是 `|SCROLL|`，实现里生成的字符串是 `|scroll element|` / `|scroll element[N]`——见 `serializer.py:1114-1120`。这是原文之间的一处不一致，我原样记录，不替它调和。）

**可交互 vs 纯文本怎么区分**：可交互元素才有 `[N]` 序号，纯文本节点直接作为一行缩进文本输出。生成代码：

`browser_use/dom/serializer/serializer.py:1114-1124`

```python
if should_show_scroll and not node.is_interactive:
    # Scrollable container but not clickable
    line = f'{depth_str}{shadow_prefix}|scroll element|<{node.original_node.tag_name}'
elif node.is_interactive:
    assert node.selector_index is not None
    new_prefix = '*' if node.is_new else ''
    scroll_prefix = '|scroll element[' if should_show_scroll else '['
    line = f'{depth_str}{shadow_prefix}{new_prefix}{scroll_prefix}{node.selector_index}]<{node.original_node.tag_name}'
elif node.original_node.tag_name.upper() == 'IFRAME':
    # Iframe element (not interactive)
    line = f'{depth_str}{shadow_prefix}|IFRAME|<{node.original_node.tag_name}'
```

文本节点：

`browser_use/dom/serializer/serializer.py:1163-1176`

```python
elif node.original_node.node_type == NodeType.TEXT_NODE:
    # Include visible text that isn't fully covered by another element
    # painted on top of it (e.g. text underneath an open modal/dropdown).
    is_visible = node.original_node.snapshot_node and node.original_node.is_visible
    if (
        is_visible
        and not node.ignored_by_paint_order
        and node.original_node.node_value
        and node.original_node.node_value.strip()
        and len(node.original_node.node_value.strip()) > 1
    ):
        clean_text = node.original_node.node_value.strip()
        formatted_text.append(f'{depth_str}{clean_text}')
```

**哪些属性会被带上**：由 `DEFAULT_INCLUDE_ATTRIBUTES` 决定，定义在 `browser_use/dom/views.py:18-82`，共 47 项。原文照抄（含注释）：

```python
DEFAULT_INCLUDE_ATTRIBUTES = [
	'title',
	'type',
	'checked',
	# 'class',
	'id',
	'name',
	'role',
	'value',
	'placeholder',
	'data-date-format',
	'alt',
	'aria-label',
	'aria-expanded',
	'data-state',
	'aria-checked',
	# ARIA value attributes for datetime/range inputs
	'aria-valuemin',
	'aria-valuemax',
	'aria-valuenow',
	'aria-placeholder',
	# Validation attributes - help agents avoid brute force attempts
	'pattern',
	'min',
	'max',
	'minlength',
	'maxlength',
	'step',
	'accept',  # File input types (e.g., accept="image/*" or accept=".pdf")
	'multiple',  # Whether multiple files/selections are allowed
	'inputmode',  # Virtual keyboard hint (numeric, tel, email, url, etc.)
	'autocomplete',  # Autocomplete behavior hint
	'aria-autocomplete',  # ARIA autocomplete type (list, inline, both)
	'list',  # Associated datalist element ID
	'data-mask',  # Input mask format (e.g., phone numbers, credit cards)
	'data-inputmask',  # Alternative input mask attribute
	'data-datepicker',  # jQuery datepicker indicator
	'format',  # Synthetic attribute for date/time input format (e.g., MM/dd/yyyy)
	'expected_format',  # Synthetic attribute for explicit expected format (e.g., AngularJS datepickers)
	'contenteditable',  # Rich text editor detection
	# Webkit shadow DOM identifiers
	'pseudo',
	# Accessibility properties from ax_node (ordered by importance for automation)
	'checked',
	'selected',
	'expanded',
	'pressed',
	'disabled',
	'invalid',  # Current validation state from AX node
	'valuemin',  # Min value from AX node (for datetime/range)
	'valuemax',  # Max value from AX node (for datetime/range)
	'valuenow',
	'keyshortcuts',
	'haspopup',
	'multiselectable',
	# Less commonly needed (uncomment if required):
	# 'readonly',
	'required',
	'valuetext',
	'level',
	'busy',
	'live',
	# Accessibility name (contains text content for StaticText elements)
	'ax_name',
]
```

注意 `'class'` 被显式注释掉了，`'href'` **从未出现在这张表里**。

**「屏幕外」是否显式标出？** 主页面用一个页面级摘要，不是逐元素标记：

`browser_use/agent/prompts.py:263-280`

```python
page_info_text = ''
if self.browser_state.page_info:
    pi = self.browser_state.page_info
    # Compute page statistics dynamically
    pages_above = pi.pixels_above / pi.viewport_height if pi.viewport_height > 0 else 0
    pages_below = pi.pixels_below / pi.viewport_height if pi.viewport_height > 0 else 0
    has_content_above = pages_above > 0
    has_content_below = pages_below > 0
    page_info_text = '<page_info>'
    page_info_text += f'{pages_above:.1f} pages above, {pages_below:.1f} pages below'
    if pages_below > 0.2:
        page_info_text += ' — scroll down to reveal more content'
    page_info_text += '</page_info>\n'
if elements_text != '':
    if not has_content_above:
        elements_text = f'[Start of page]\n{elements_text}'
    if not has_content_below:
        elements_text = f'{elements_text}\n[End of page]'
```

只有 **iframe 内部**有逐元素的「屏幕外」清单，带「往下几页」的距离：

`browser_use/dom/serializer/serializer.py:1190-1199`

```python
if node.original_node.hidden_elements_info:
    # Show specific interactive elements with scroll distances
    hidden = node.original_node.hidden_elements_info
    hint_lines = [f'{depth_str}... ({len(hidden)} more elements below - scroll to reveal):']
    for elem in hidden:
        hint_lines.append(f'{depth_str}    <{elem["tag"]}> "{elem["text"]}" ~{elem["pages"]} pages down')
    formatted_text.extend(hint_lines)
elif node.original_node.has_hidden_content:
    # Generic hint for non-interactive hidden content
    formatted_text.append(f'{depth_str}... (more content below viewport - scroll to reveal)')
```

「往下几页」的算法（`browser_use/dom/service.py:125`）：

```python
pages_down = round(y_pos / viewport_height, 1) if viewport_height > 0 else 0
```

而系统提示里那条直白的告知，是这份材料里最短也最关键的一行：

`browser-use@d5453ae browser_use/agent/system_prompts/system_prompt.md:75`

```
- By default, only elements in the visible viewport are listed.
```

**页面级前缀**还有一段统计摘要，逐字见 `browser_use/agent/prompts.py:229-250`，生成形如：

```
<page_stats>{N} links, {N} interactive, {N} iframes, {N} images, {N} total elements</page_stats>
```

并且在元素太少或疑似骨架屏时插入提示：

```python
if page_stats['total_elements'] < 10:
    stats_text += 'Page appears empty - consider waiting - '
```

整块 `browser_state` 的拼装模板（`browser_use/agent/prompts.py:328-334`）：

```python
browser_state = f"""{stats_text}{current_tab_text}
Available tabs:
{tabs_text}
{page_info_text}
{state_error_text}{recent_events_text}{closed_popups_text}{pdf_message}Interactive elements{truncated_text}:
{elements_text}
"""
```

#### 2.1.4 滚动

**读到的原文。** scroll 是交给模型的动作，schema 与描述如下：

`browser-use@d5453ae browser_use/tools/views.py:130-133`

```python
class ScrollAction(BaseModel):
	down: bool = Field(default=True, description='down=True=scroll down, down=False scroll up')
	pages: float = Field(default=1.0, description='0.5=half page, 1=full page, 10=to bottom/top')
	index: int | None = Field(default=None, description='Optional element index to scroll within specific element')
```

`browser_use/tools/service.py:1379-1382`

```python
@self.registry.action(
    """Scroll by pages. REQUIRED: down=True/False (True=scroll down, False=scroll up, default=True). Optional: pages=0.5-10.0 (default 1.0). Use index for scroll elements (dropdowns/custom UI). High pages (10) reaches bottom. Multi-page scrolls sequentially. Viewport-based height, fallback 1000px/page.""",
    param_model=ScrollAction,
)
```

另有一个 `Scroll to text.` 动作（`browser_use/tools/service.py:1503`）。

**点击前会不会自己滚动？** 会，而且用的是 `IfNeeded` 变体：

`browser_use/browser/watchdogs/default_action_watchdog.py:766-774`

```python
# Scroll element into view FIRST before getting coordinates
try:
    await cdp_session.cdp_client.send.DOM.scrollIntoViewIfNeeded(
        params={'backendNodeId': backend_node_id}, session_id=session_id
    )
    await asyncio.sleep(0.05)  # Wait for scroll to complete
    self.logger.debug('Scrolled element into view before getting coordinates')
except Exception as e:
    self.logger.debug(f'Failed to scroll element into view: {e}')
```

全仓库 `scrollIntoView` 相关调用共 6 处（`default_action_watchdog.py:768`、`:1783`、`:2767`、`:2794`，`actor/element.py:261`、`:366`），其中 5 处是 `DOM.scrollIntoViewIfNeeded`，只有 `default_action_watchdog.py:2794` 是无条件的 `scrollIntoView({behavior: 'smooth', block: 'center'})`，且作用于 `node.parentElement`。

**在抽取侧，browser-use 不跨视口抽取**：`viewport_threshold=1000` 是唯一的跨视口范围，且它是绝对像素而非「N 个视口」。

**我的推断。** 「点击会滚动 → 滚动改变下一次抽取的可见集合」这个因果链在 browser-use 里同样存在（`scrollIntoViewIfNeeded` + 视口 ±1000px 硬过滤）。原文里我**没有找到**任何代码是为了打断这个循环而写的——没有「记住上一帧看到过什么」的合并逻辑，序列化器里的 `previous_cached_state` 只被用来给新出现的元素打 `*` 标记（`serializer.py:73-81`、`:1120`），不用来把上一帧的元素补回来。它对这条链的**缓解**是三个别的东西：(a) `IfNeeded` 只在元素不可见时才滚；(b) `<page_info>` 明确告诉模型页面还有多少内容在上下；(c) `<agent_history>` 里保留了之前每一步的 `memory` 文本（见 §3.1），所以「导航栏在第 3 步见过」这件事以自然语言而非元素表的形式留在上下文里。以上三点是原文，「因此循环被削弱」是我的判断。

---

### 2.2 Playwright MCP

#### 2.2.1 是否剪枝？有没有硬上限？

**读到的原文。** `browser_snapshot` 工具的完整定义：

`playwright@46cd500 packages/playwright-core/src/tools/backend/snapshot.ts:34-56`

```ts
const snapshot = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_snapshot',
    title: 'Page snapshot',
    description: 'Capture accessibility snapshot of the current page, this is better than screenshot',
    inputSchema: z.object({
      target: z.string().optional().describe(elementTargetDescription),
      filename: z.string().optional().describe('Save snapshot to a file instead of returning it in the response. Relative file names are resolved against the workspace root.'),
      depth: z.number().optional().describe('Limit the depth of the snapshot tree'),
      boxes: z.boolean().optional().describe('Include each element\'s bounding box as [box=x,y,width,height] in the snapshot. Coordinates are viewport-relative, in CSS pixels (Element.getBoundingClientRect)'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    let resolved: { locator: playwright.Locator | undefined, resolved: string } = { locator: undefined, resolved: '' };
    if (params.target)
      resolved = await tab.targetLocator({ target: params.target });
    response.setIncludeFullSnapshot(params.filename, resolved.locator, params.depth, params.boxes);
  },
});
```

没有元素数上限，没有字符数上限。我在 `packages/playwright-core/src/tools/backend/*.ts` 全目录 grep 过 `truncat|maxLength|budget|limit|slice(0`，唯一命中的预算逻辑是 `_enforceOutputBudget`，而它管的是**磁盘**：

`playwright@46cd500 packages/playwright-core/src/tools/backend/response.ts:237-246`

```ts
private async _enforceOutputBudget(): Promise<void> {
  const maxSize = this._context.config.outputMaxSize;
  if (!maxSize)
    return;
  const dir = resolveOutputDir(this._context.options);
  let entries: { path: string, size: number, mtimeMs: number }[];
  try {
    entries = await listFilesRecursive(dir);
  } catch {
    return;
  }
```

（它随后按 `mtimeMs` 删除最旧的输出文件，`response.ts:253-265`。与提示词大小无关。）

#### 2.2.2 如果剪枝，按什么规则？

**读到的原文。** 有一层叫 **distillation** 的处理，它的头部注释把意图写得很直白：

`playwright@46cd500 packages/injected/src/ariaSnapshotDistiller.ts:23-31`

```ts
// Distillation makes the snapshot less verbose without losing information: after the full tree is
// built, a single traversal applies the chained plugins below, babel-style. Each plugin is a
// visitor: `enter` runs pre-order, `exit` runs post-order after the children were traversed - and
// possibly removed, unwrapped or inlined. Either hook can detach the node by returning 'remove'
// (from `enter`, the subtree is then not traversed and no further hooks run for it), or replace
// the node with its children by returning 'unwrap' (from `enter`, the hoisted children are
// re-visited in the node's place; from `exit`, they were already traversed and are spliced in as
// is). Plugins mutate the tree in place; `snapshot.info` and `snapshot.refs` are left intact, so
// refs of removed nodes still resolve through the aria-ref selector engine.
```

`ai` 模式的插件链（`ariaSnapshotDistiller.ts:245-263`）：

```ts
// Structural normalization applies to all modes - it defines the canonical tree shape.
const normalizePlugins: DistillerPlugin[] = [
  mergeStringChildren,
  unwrapSingleChildGenerics,
];

// The ai preset compresses the snapshot on top of normalization. It runs as one traversal:
// `removeRedundantNames` bookkeeping must observe every node the tree retains, including the
// wrappers that `unwrapSingleChildGenerics` is about to unwrap. On exit, text is first inlined
// into the node, so that `removeNameRepeatingChild` faces the real parent when it compares.
const aiPlugins: DistillerPlugin[] = [
  mergeStringChildren,
  removeNamelessImages,
  removeRedundantNames,
  inlineTextIntoGeneric,
  removeNameRepeatingChild,
  unwrapSingleChildGenerics,
];
```

六个插件的判据分别是：合并相邻文本子节点、删掉**无名且无内容**的装饰图（`removeNamelessImages`，且 "A clickable image outside of any clickable container is not decorative though … and is kept."，`ariaSnapshotDistiller.ts:158-160`）、删掉**与已呈现内容重复**的 accessible name、把单一文本子节点内联、删掉**重复父级名字**的子节点、拆掉只有一个 ref 子节点的 `generic` 包装。**全部是「同一信息重复出现」判据，没有一条与目标或角色重要性相关。**

**视口无关**。`ai` 模式的可见性口径：

`playwright@46cd500 packages/injected/src/ariaSnapshot.ts:58-70`

```ts
function toInternalOptions(options: AriaTreeOptions): InternalOptions {
  const renderBoxes = options.boxes;
  if (options.mode === 'ai') {
    // For AI consumption.
    return {
      visibility: 'ariaOrVisible',
      refs: 'interactable',
      refPrefix: options.refPrefix,
      includeGenericRole: true,
      renderActive: !options.doNotRenderActive,
      renderCursorPointer: true,
      renderBoxes,
    };
  }
```

`refs: 'interactable'` 的含义：

`packages/injected/src/ariaSnapshot.ts:220-232`

```ts
function computeAriaRef(ariaNode: aria.AriaNode, options: InternalOptions) {
  if (options.refs === 'none')
    return;
  if (options.refs === 'interactable' && (!ariaNode.box.visible || !ariaNode.receivesPointerEvents))
    return;

  const element = ariaNodeElement(ariaNode);
  let ariaRef = (element as any)._ariaRef as AriaRef | undefined;
  if (!ariaRef || ariaRef.role !== ariaNode.role || ariaRef.name !== ariaNode.name) {
    ariaRef = { role: ariaNode.role, name: ariaNode.name, ref: (options.refPrefix ?? '') + 'e' + (++lastRef) };
    (element as any)._ariaRef = ariaRef;
  }
  ariaNode.ref = ariaRef.ref;
}
```

而 `box.visible` 的定义**只看渲染，不看滚动位置**：

`playwright@46cd500 packages/injected/src/domUtils.ts:120-140`

```ts
export function computeBox(element: Element) {
  // Note: this logic should be similar to waitForDisplayedAtStablePosition() to avoid surprises.
  const style = getElementComputedStyle(element);
  if (!style)
    return { visible: true, inline: false };
  const cursor = style.cursor;
  if (style.display === 'contents') {
    // display:contents is not rendered itself, but its child nodes are.
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 /* Node.ELEMENT_NODE */ && isElementVisible(child as Element))
        return { visible: true, inline: false, cursor };
      if (child.nodeType === 3 /* Node.TEXT_NODE */ && isVisibleTextNode(child as Text))
        return { visible: true, inline: true, cursor };
    }
    return { visible: false, inline: false, cursor };
  }
  if (!isElementStyleVisibilityVisible(element, style))
    return { cursor, visible: false, inline: false };
  const rect = element.getBoundingClientRect();
  return { cursor, visible: rect.width > 0 && rect.height > 0, inline: style.display === 'inline' };
}
```

**我的推断。** `rect.width > 0 && rect.height > 0` 对滚动出视口的元素同样成立（`getBoundingClientRect` 只是坐标变负，宽高不变），所以 Playwright MCP 交给模型的快照覆盖**整页**，与用户/agent 滚到哪里无关。「屏幕外」这个概念在这套序列化里根本不存在，因此也没有任何标记去表示它——除非显式传 `boxes: true`，那时每个元素带 `[box=x,y,width,height]`，坐标是**视口相对**的（工具描述原文：「Coordinates are viewport-relative, in CSS pixels」），模型可以自己算是否在屏内。

#### 2.2.3 序列化格式（含真实样例）

**读到的原文。** 缩进 YAML 树。每行的 key 由这段代码拼出：

`playwright@46cd500 packages/isomorphic/ariaSnapshotRenderer.ts:36-78`

```ts
const createKey = (node: AriaNodeJSON): string => {
  let key: string = node.role;
  // Yaml has a limit of 1024 characters per key, and we leave some space for role and attributes.
  if (node.name && node.name.length <= 900) {
    const name = renderString(node.name);
    if (name) {
      const stringifiedName = name.startsWith('/') && name.endsWith('/') ? name : JSON.stringify(name);
      key += ' ' + stringifiedName;
    }
  }
  if (node.checked === 'mixed')
    key += ` [checked=mixed]`;
  if (node.checked === true)
    key += ` [checked]`;
  if (node.disabled)
    key += ` [disabled]`;
  if (node.expanded)
    key += ` [expanded]`;
  if (node.active)
    key += ` [active]`;
  if (node.invalid === 'grammar' || node.invalid === 'spelling')
    key += ` [invalid=${node.invalid}]`;
  if (node.invalid === true)
    key += ` [invalid]`;
  if (node.level)
    key += ` [level=${node.level}]`;
  if (node.pressed === 'mixed')
    key += ` [pressed=mixed]`;
  if (node.pressed === true)
    key += ` [pressed]`;
  if (node.selected === true)
    key += ` [selected]`;
  if (node.ariaHidden)
    key += ` [aria-hidden]`;
  if (node.ref) {
    key += ` [ref=${node.ref}]`;
    if (node.cursor === 'pointer')
      key += ' [cursor=pointer]';
  }
  if (node.box)
    key += ` [box=${node.box.x},${node.box.y},${node.box.width},${node.box.height}]`;
  return key;
};
```

`url` 与 `placeholder` 不进 key，而是作为子项（`ariaSnapshotRenderer.ts:86-107`）：

```ts
const props: [string, string][] = [];
if (node.url !== undefined)
  props.push(['url', node.url]);
if (node.placeholder !== undefined)
  props.push(['placeholder', node.placeholder]);
...
  for (const [name, value] of props)
    lines.push(indent(depth + 1) + '- /' + name + ': ' + yamlEscapeValueIfNeeded(value));
```

`url` 的来源是 `href`（`packages/injected/src/ariaSnapshot.ts:198-201`）：

```ts
if (ariaNode.role === 'link' && element.hasAttribute('href')) {
  const href = element.getAttribute('href')!;
  ariaNode.props['url'] = truncateDataUrl(href);
}
```

**真实样例（仓库测试里的断言，原样抄）。**

一段完整的响应文本，含分节标题（`playwright@46cd500 tests/mcp/test-debug.spec.ts:144-164`）：

````
### Paused on error:
Error: non-api error

### Page 1 of 2
- Page URL: ${server.EMPTY_PAGE}
- Page Title:
- Page Snapshot:
```yaml

```

### Page 2 of 2
- Page URL: ${server.PREFIX + '/wrappedlink.html'}
- Page Title:
- Page Snapshot:
```yaml
- link "123321" [ref=e3] [cursor=pointer]:
  - /url: "#clicked"
```

### Task
Try recovering from the error prior to continuing
````

一个带状态标记的嵌套树（`tests/mcp/core.spec.ts:194-197`）：

```
- listbox [ref=e2]:
  - option "Foo" [ref=e3]
  - option "Bar" [selected] [ref=e4]
  - option "Baz" [selected] [ref=e5]
```

`depth` 参数的效果（`tests/mcp/core.spec.ts:308-328`），`depth: 1` 与 `depth: 2` 的同一页面：

```
- list [ref=e2]:
  - listitem [ref=e3]: text
  - listitem [ref=e4]
```

```
- list [ref=e2]:
  - listitem [ref=e3]: text
  - listitem [ref=e4]:
    - button "Button" [ref=e5]
```

`--snapshot-boxes` 的效果（`tests/mcp/snapshot-mode.spec.ts:108-112`）：

```
- button "click" [ref=e1] [box=100,50,80,40]
```

**可交互 vs 纯文本怎么区分**：有 `[ref=eN]` 的才可交互（`refs: 'interactable'`，见 §2.2.2）；纯文本以 `- text: ...` 或作为节点值 `- role "name": text` 出现（`ariaSnapshotRenderer.ts:32-36`、`:97-101`）。另有 `[cursor=pointer]` 这个额外线索。

**快照太大时的官方做法**，见 Playwright 自带 skill 原文（`playwright@46cd500 packages/playwright-core/src/tools/skills/playwright-cli/SKILL.md:280-303`）：

```
You can also take a snapshot on demand using `playwright-cli snapshot` command. All the options below can be combined as needed.

# default - save to a file with timestamp-based name
playwright-cli snapshot

# save to file, use when snapshot is a part of the workflow result
playwright-cli snapshot --filename=after-click.yaml

# snapshot an element instead of the whole page
playwright-cli snapshot "#main"

# limit snapshot depth for efficiency, take a partial snapshot afterwards
playwright-cli snapshot --depth=4
playwright-cli snapshot e34

# include each element's bounding box as [box=x,y,width,height]
playwright-cli snapshot --boxes

# search a large snapshot instead of capturing it all — returns matching nodes
# with 3 lines of context around each match (like grep -C)
playwright-cli find "Add to cart"
playwright-cli find --regex "\\$[0-9]+\\.[0-9]{2}"
```

`browser_find` 的实现确实是在整页快照文本上做 grep：

`playwright@46cd500 packages/playwright-core/src/tools/backend/find.ts:62-70`

```ts
const snapshot = await tab.page.ariaSnapshot({ mode: 'ai' });
const lines = snapshot.split('\n');
const indents = lines.map(indentOf);
const matchedLines: number[] = [];
for (let i = 0; i < lines.length; i++) {
  if (matches(lines[i]))
    matchedLines.push(i);
}
```

`SKILL.md:269-278` 还给出了默认响应形态——快照默认**存成文件、只回一个链接**：

```
After each command, playwright-cli provides a snapshot of the current browser state.

> playwright-cli goto https://example.com
### Page
- Page URL: https://example.com/
- Page Title: Example Domain
### Snapshot
[Snapshot](.playwright-cli/page-2026-02-14T19-22-42-679Z.yml)
```

#### 2.2.4 滚动

**读到的原文。** 从 `packages/playwright-core/src/tools/backend/*.ts` 抓出的完整工具名清单（79 个）：

```
browser_annotate, browser_check, browser_click, browser_close, browser_console_clear,
browser_console_messages, browser_cookie_clear, browser_cookie_delete, browser_cookie_get,
browser_cookie_list, browser_cookie_set, browser_drag, browser_drop, browser_evaluate,
browser_file_upload, browser_fill_form, browser_find, browser_generate_locator,
browser_get_config, browser_handle_dialog, browser_hide_highlight, browser_highlight,
browser_hover, browser_keydown, browser_keyup, browser_localstorage_clear,
browser_localstorage_delete, browser_localstorage_get, browser_localstorage_list,
browser_localstorage_set, browser_mouse_click_xy, browser_mouse_down, browser_mouse_drag_xy,
browser_mouse_move_xy, browser_mouse_up, browser_mouse_wheel, browser_navigate,
browser_navigate_back, browser_navigate_forward, browser_network_clear,
browser_network_request, browser_network_requests, browser_network_state_set,
browser_pdf_save, browser_press_key, browser_press_sequentially, browser_reload,
browser_resize, browser_resume, browser_route, browser_route_list, browser_run_code_unsafe,
browser_select_option, browser_sessionstorage_clear, browser_sessionstorage_delete,
browser_sessionstorage_get, browser_sessionstorage_list, browser_sessionstorage_set,
browser_set_storage_state, browser_snapshot, browser_start_recording, browser_start_tracing,
browser_start_video, browser_stop_recording, browser_stop_tracing, browser_stop_video,
browser_storage_state, browser_tabs, browser_take_screenshot, browser_type, browser_uncheck,
browser_unroute, browser_verify_element_visible, browser_verify_list_visible,
browser_verify_text_visible, browser_verify_value, browser_video_chapter,
browser_video_hide_actions, browser_video_show_actions, browser_wait_for
```

**清单里没有 `browser_scroll`。** 与滚动最接近的是 `browser_mouse_wheel`（在 `mouse.ts`，属于 `vision` 能力的坐标类工具）。

点击的实现直接调用 Playwright 的 `locator.click()`：

`playwright@46cd500 packages/playwright-core/src/tools/backend/snapshot.ts:87-92`

```ts
await tab.waitForCompletion(async () => {
  if (params.doubleClick)
    await locator.dblclick(options);
  else
    await locator.click(options);
});
```

**我的推断。** Playwright 的 `locator.click()` 内部会做 actionability 检查并把元素滚入视口，所以「点击导致滚动」在这里也发生。但因为快照口径与滚动位置无关（§2.2.2），滚动**不改变**下一次快照包含哪些元素——只可能改变 `[box=...]` 的坐标值和 `[active]` 标记。这条因果链在 Playwright MCP 里是断开的，而断开的原因不是有代码专门去断它，而是**它从一开始就没有把视口引入可见性口径**。

---

### 2.3 WebVoyager

**读到的原文（论文）。** arXiv:2401.13919 v4，§3.3 Observation Space / §3.4 Action Space。

- Set-of-Mark：「we overlay bounding boxes of the interactive elements on the websites to better guide the agent's action prediction.」
- 伴随文本：「the textual content embedded within the interactive element, the type of the element, and possibly some comment text in the aria-label attribute.」
- 上下文裁剪：「we perform context clipping to remove outdated web page information and only keep the three most recent observations in the inputs, and we keep the entire history of thoughts and actions to better guide the agent.」

**读到的原文（代码）。** 元素采集的注入脚本（`WebVoyager@5a78967 utils.py:55-93`）：

```js
var vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
var vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);

var rects = [...element.getClientRects()].filter(bb => {
var center_x = bb.left + bb.width / 2;
var center_y = bb.top + bb.height / 2;
var elAtCenter = document.elementFromPoint(center_x, center_y);

return elAtCenter === element || element.contains(elAtCenter)
}).map(bb => {
const rect = {
    left: Math.max(0, bb.left),
    top: Math.max(0, bb.top),
    right: Math.min(vw, bb.right),
    bottom: Math.min(vh, bb.bottom)
};
...
return {
element: element,
include:
    (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT") ||
    (element.tagName === "BUTTON" || element.tagName === "A" || (element.onclick != null) || window.getComputedStyle(element).cursor == "pointer") ||
    (element.tagName === "IFRAME" || element.tagName === "VIDEO" || element.tagName === "LI" || element.tagName === "TD" || element.tagName === "OPTION")
,
area,
rects,
text: element.textContent.trim().replace(/\s{2,}/g, ' ')
};
}).filter(item =>
item.include && (item.area >= 20)
);
```

序列化格式（`utils.py:179-210`）——**扁平的 tab 分隔单行串**，无层级：

```python
format_ele_text.append(f"[{web_ele_id}]: <{ele_tag_name}> \"{label_text}\", \"{ele_aria_label}\";")
...
format_ele_text = '\t'.join(format_ele_text)
```

名字长度上限（`utils.py:194`）：`elif label_text and len(label_text) < 200:`。

动作空间原文（`WebVoyager@5a78967 prompts.py:2-19`）：

```
1. Click a Web Element.
2. Delete existing content in a textbox and then type content. 
3. Scroll up or down. Multiple scrolls are allowed to browse the webpage. Pay attention!! The default scroll is the whole window. If the scroll widget is located in a certain area of the webpage, then you have to specify a Web Element in that area. I would hover the mouse there and then scroll.
4. Wait. Typically used to wait for unfinished webpage processes, with a duration of 5 seconds.
5. Go back, returning to the previous webpage.
6. Google, directly jump to the Google search page. When you can't find information in some websites, try starting over with Google.
7. Answer. This action should only be chosen when all questions in the task have been solved.

Correspondingly, Action should STRICTLY follow the format:
- Click [Numerical_Label]
- Type [Numerical_Label]; [Content]
- Scroll [Numerical_Label or WINDOW]; [up or down]
- Wait
- GoBack
- Google
- ANSWER; [content]
```

滚动实现（`run.py:212-216`）：

```python
if scroll_ele_number == "WINDOW":
    if scroll_content == 'down':
        driver_task.execute_script(f"window.scrollBy(0, {args.window_height*2//3});")
    else:
        driver_task.execute_script(f"window.scrollBy(0, {-args.window_height*2//3});")
```

上下文裁剪的实现（`utils.py:258-279`）：超出 `max_img_num` 的历史观察被替换成一句占位文本：

```python
msg_no_pdf = curr_msg['content'][0]["text"].split("Observation:")[0].strip() + "Observation: A screenshot and some texts. (Omitted in context.)"
```

**我的推断。** `document.elementFromPoint(center_x, center_y)` 对视口之外的坐标返回 `null`，所以 `elAtCenter === element` 不成立，该 rect 被过滤掉，`area` 归零，再被 `item.area >= 20` 剔除。因此 WebVoyager 的观察是**严格视口内**的，且这是采集脚本的副作用而非一条显式规则。它没有任何元素条数上限、没有打分、没有目标相关性；能不能看到目标元素完全取决于模型自己决定滚到哪里。

---

### 2.4 Mind2Web

**读到的原文（论文）。** arXiv:2306.06070 v3，§3「Method: MindAct」。

- 动机：「Raw HTML documents, which could consist of thousands of elements, are either infeasible or cost-prohibitive to be directly fed into LLMs.」
- 打分方式：cross-encoder 架构的 encoder-only LM，query 是「the task description with previous actions」的拼接。
- 第二阶段输入规模（§4.3）：「top-50 elements with the largest logits」。
- 多选轮次：「We incorporate up to 5 candidate elements within each input, together with a None option, and partition the candidate set into several groups.」

**读到的原文（代码）。** 打分 query 的确切格式（`Mind2Web@33bd95c src/candidate_generation/dataloader.py:63-74`）：

```python
query = (
    f'task is: {sample["confirmed_task"]}\n'
    f'Previous actions: {"; ".join(sample["previous_actions"][-3:])}'
)

return InputExample(
    texts=[
        candidate[1],
        query,
    ],
    label=label,
)
```

`top_k` 的默认与 README 原文（`Mind2Web@33bd95c README.md:186-191`、`:243-248`）：

```
  +top_k=50
...
- `top_k`: Number of candidates to consider for each action, we use 50 in the paper for most experiments.
```

```
  +top_k=50
...
- `top_k`: Number of candidates to consider for each action, we use 50 in the paper for most experiments, except for gpt-4 where we use top-10.
```

DOM 保留规则——只保留候选元素及其**祖先、有限深度的后代、左右各 3 个兄弟**（`Mind2Web@33bd95c src/data_utils/dom_utils.py:203-242`）：

```python
def prune_tree(
    dom_tree,
    candidate_set,
    max_depth=5,
    max_children=50,
    max_sibling=3,
):
    nodes_to_keep = set()
    for candidate_id in candidate_set:
        candidate_node = dom_tree.xpath(f'//*[@backend_node_id="{candidate_id}"]')[0]
        nodes_to_keep.add(candidate_node.attrib["backend_node_id"])
        # get all ancestors
        nodes_to_keep.update(...)
        # get descendants with max depth
        nodes_to_keep.update(...)
        # get siblings within range
        ...
```

多选提示词的拼装（`Mind2Web@33bd95c src/action_prediction/dataloader.py:93-113`）：

```python
seq_input = (
    "Based on the HTML webpage above, try to complete the following task:\n"
    f"Task: {sample['confirmed_task']}\n"
    f"Previous actions:\n"
)
if len(sample["previous_actions"]) > 0:
    for action in sample["previous_actions"][-previous_k:]:
        seq_input += f"{action}\n"
else:
    seq_input += "None\n"
seq_input += (
    "What should be the next action? Please select from the following choices "
    "(If the correct action is not in the page above, please select A. 'None of the above'):\n\n"
    "A. None of the above\n"
)
for idx, choice in enumerate(choices):
    # convert to ascii A, B, C, D, ...
    seq_input += f"{chr(66 + idx)}. {choice[1]}\n"
```

每个选项的文本被截到 10 个词（`dataloader.py:34-41`）：

```python
" ".join(
    get_tree_repr(
        node,
        id_mapping=id_mapping,
        keep_html_brackets=keep_html_brackets,
    )[0].split()[:10]
),
```

一个真实的完整 prompt（`Mind2Web@33bd95c src/action_prediction/llm_prompt.json`，第二条 user message，原样抄）：

```
'''
<html> <div> <main main> <section tabpanel> <div> <ul tablist> <li tab heading level 3 search and> </li> <li id=0 tab heading level 3 search and> <span> Hotel </span> </li> ... </html>
'''

Based on the HTML webpage above, try to complete the following task:
Task: Compare the fare types to book a 1-adult ticket from Springfiels, IL to Austin, TX for April 29th 2023
Previous actions:
[combobox]  Enter your departing city, airport name, or airpor... -> TYPE: SPRINGFIELD
[button]  Springfield, IL, US (SPI) -> CLICK
[combobox]  Enter your destination city, airport name, or airp... -> TYPE: AUSTIN
[button]  Austin, TX, US (AUS) -> CLICK
What should be the next action? Please select from the following choices (If the correct action is not in the page above, please select A. 'None of the above'):

A. None of the above
B. <li id=0 tab heading level 3 search and> <span> Hotel
C. <div id=1> <div> <span> Dates* </span> <button button clear dates
D. <ul id=2> <a mobile tools> </a> <a open united's tiktok
```

对应的 assistant 答案是 `Answer: A.`——即「以上都不是」。

多轮淘汰的驱动代码（`Mind2Web@33bd95c src/action_prediction/metric.py:141-147`）：

```python
all_candidates = pos_ids + neg_ids
random.shuffle(all_candidates)
final_prediction = None
outputs = []
while len(all_candidates) > 1:
    candidate_ids = all_candidates[:5]
    all_candidates = all_candidates[5:]
```

**我的推断。** Mind2Web 是这四个来源里唯一把「与目标的相关性」当成剪枝主判据的：它把 top-50 的选择完全交给一个专门为此训练的 cross-encoder，而不是手写规则。代价是每一步需要 ⌈50/5⌉ ≈ 10 次以上的 LLM 调用（多轮淘汰），且这套流程在原始设定里是**离线的单步动作预测评测**，不是在线交互 agent。「没有滚动动作」在这里不是设计选择，而是数据集形态使然——它面对的是静态 HTML 快照。

---

### 2.5 四者并置

| | browser-use 0.13.10 | Playwright MCP 0.0.80 | WebVoyager | Mind2Web (MindAct) |
|---|---|---|---|---|
| 剪枝？ | 是（视口硬过滤 + 几何去重 + 字符截断） | 只做无损蒸馏 | 是（视口 + `area>=20`，采集脚本的副作用） | 是（模型排序 top-k） |
| 硬上限 | 40000 **字符**，尾部切片 | 无 | 无 | top-50（GPT-4 用 top-10），每轮 5 个候选 |
| 视口 | 硬过滤，纵向 ±1000px | 无视口概念（`width>0 && height>0`） | 严格视口内 | 无（静态快照） |
| 目标相关性 | 无 | 无 | 无 | **有**（cross-encoder，query = task + previous actions） |
| 导航/landmark 保底 | 无 | 无 | 无 | 无（但 `prune_tree` 保留全部祖先） |
| 格式 | 缩进树 `[N]<tag attr=v />` | 缩进 YAML `- role "name" [ref=eN]` | 扁平 tab 分隔 `[N]: <tag> "text";` | 剪过枝的 HTML + 字母选项 |
| 屏幕外是否说明 | `<page_info>N pages above/below`、`[Start/End of page]`、iframe 内 `~N pages down`、系统提示第 75 行 | 不适用 | 不说明 | 不适用 |
| 滚动 | 模型动作（`scroll(down, pages, index)`） | **无 scroll 工具** | 模型动作（`Scroll [N or WINDOW]; [up/down]`，步长 `2/3` 视口） | 无 |
| 点击是否自动滚动 | `DOM.scrollIntoViewIfNeeded` | `locator.click()` 内建 | Selenium 点击 | 不适用 |

---

## 3. 问题二：怎么逼模型先判断「目标是不是已经达成」

### 3.1 browser-use 的 `AgentOutput` / `current_state` 确切 schema

**读到的原文。** 逐字，全文（`browser-use@d5453ae browser_use/agent/views.py:381-415`）：

```python
class AgentBrain(BaseModel):
	thinking: str | None = None
	evaluation_previous_goal: str
	memory: str
	next_goal: str


class AgentOutput(BaseModel):
	model_config = ConfigDict(arbitrary_types_allowed=True, extra='forbid')

	thinking: str | None = None
	evaluation_previous_goal: str | None = None
	memory: str | None = None
	next_goal: str | None = None
	current_plan_item: int | None = None
	plan_update: list[str] | None = None
	action: list[ActionModel] = Field(
		...,
		json_schema_extra={'min_items': 1},  # Ensure at least one action is provided
	)

	@classmethod
	def model_json_schema(cls, **kwargs):
		schema = super().model_json_schema(**kwargs)
		schema['required'] = ['evaluation_previous_goal', 'memory', 'next_goal', 'action']
		return schema

	@property
	def current_state(self) -> AgentBrain:
		"""For backward compatibility - returns an AgentBrain with the flattened properties"""
		return AgentBrain(
			thinking=self.thinking,
			evaluation_previous_goal=self.evaluation_previous_goal if self.evaluation_previous_goal else '',
			memory=self.memory if self.memory else '',
			next_goal=self.next_goal if self.next_goal else '',
		)
```

**几个必须原样记下的事实：**

1. **这几个字段上一个 `description` 都没有。** Pydantic 层是裸的；语义全部由系统提示承担（§3.3）。这与本项目把语义写进 tool schema `description`（`src/agent/guide/agent.ts` 的 `previous_step` / `evidence`）是相反的做法。
2. **`current_state` 已经不是真实字段，只是一个向后兼容的 property**——原文注释写着 `"""For backward compatibility - returns an AgentBrain with the flattened properties"""`。字段在 0.13.10 里是**扁平**的。
3. **`required` 是被手工覆写的**：`schema['required'] = ['evaluation_previous_goal', 'memory', 'next_goal', 'action']`。四项都必填，`thinking` / `current_plan_item` / `plan_update` 可选。
4. **是否每一步都要？** 是——除非开 `flash_mode`。`flash_mode` 的变体把三个反思字段**全部删掉**（`browser_use/agent/views.py:461-472`）：

```python
class AgentOutputFlashMode(AgentOutput):
    @classmethod
    def model_json_schema(cls, **kwargs):
        schema = super().model_json_schema(**kwargs)
        # Remove thinking, evaluation_previous_goal, next_goal, and plan fields
        del schema['properties']['thinking']
        del schema['properties']['evaluation_previous_goal']
        del schema['properties']['next_goal']
        schema['properties'].pop('current_plan_item', None)
        schema['properties'].pop('plan_update', None)
        # Update required fields to only include remaining properties
        schema['required'] = ['memory', 'action']
        return schema
```

`flash_mode` 的开关注释（`browser_use/agent/views.py:73`）：

```python
flash_mode: bool = False  # If enabled, disables evaluation_previous_goal and next_goal, and sets use_thinking = False
```

5. **每次调用送的是 system + 一条 user message，不累积对话**。`_set_message_with_type` 只有两个槽位（`browser_use/agent/message_manager/service.py:556-566`）：

```python
if message_type == 'system':
    self.state.history.system_message = message
elif message_type == 'state':
    if self.sensitive_data:
        message = self._filter_sensitive_data(message)
    self.state.history.state_message = message
```

历史是作为**文本块**塞进那条 user message 的 `<agent_history>` 里（`browser_use/agent/prompts.py:484` 传入 `agent_history_description`），格式在系统提示里定义（`system_prompt.md:30-39`）：

```
<agent_history>
Agent history will be given as a list of step information as follows:
<step_{{step_number}}>:
Evaluation of Previous Step: Assessment of last action
Memory: Your memory of this step
Next Goal: Your goal for this step
Action Results: Your actions and their results
</step_{{step_number}}>
and system messages wrapped in <sys> tag.
</agent_history>
```

**我的推断。** `AgentOutput` 的字段声明顺序是 `thinking → evaluation_previous_goal → memory → next_goal → current_plan_item → plan_update → action`，而系统提示 `<output>` 块（`system_prompt.md:232-243`）给出的 JSON 模板顺序完全一致。在受 JSON schema 约束的解码里，属性按 schema 顺序生成，所以这三个反思字段是**在 `action` 被写出之前**产生的 token。也就是说 browser-use 的「先判断再行动」不是靠一个专门的字段，而是靠**字段顺序 + 全部必填**。但要注意：`evaluation_previous_goal` 和本项目的 `previous_step` 一样，问的是**过去**（「上一步成功了吗」）；`next_goal` 问的是**未来**。**这份 schema 里同样没有一个字段直接问「我现在是不是已经到了」**——那个判断被完全下放给系统提示（§3.3）与 `done` 动作本身。

### 3.2 `done` 是动作还是字段？

**读到的原文。** 是动作，注册在与其他动作同一个 registry 里（`browser-use@d5453ae browser_use/tools/service.py:2048-2053`）：

```python
@self.registry.action(
    'Complete task. Only report actions you performed and data you extracted in this session.',
    param_model=DoneAction,
)
async def done(params: DoneAction, file_system: FileSystem):
    user_message = params.text
```

它**带自评**。`DoneAction` 的完整定义（`browser_use/tools/views.py:89-101`），逐字：

```python
class DoneAction(BaseModel):
	text: str = Field(
		description=(
			'Final message to the user. '
			'ONLY report data you directly observed in browser_state, tool outputs, or screenshots during this session. '
			'Do NOT use training knowledge to fill gaps — if information was not found on the page, say so explicitly. '
			'Do NOT claim completion of steps from compacted_memory or prior session summaries '
			'unless you explicitly verified them yourself. '
			'If uncertain whether a prior step completed, say so explicitly.'
		)
	)
	success: bool = Field(default=True, description='True if user_request completed successfully')
	files_to_display: list[str] | None = Field(default=[])
```

执行结果（`browser_use/tools/service.py:2082-2088`）：

```python
return ActionResult(
    is_done=True,
    success=params.success,
    extracted_content=user_message,
    long_term_memory=memory,
    attachments=attachments,
)
```

**结构上没有任何「先判断是否到达、再选动作」的前置关卡。** 达成与否是模型在动作列表里选 `done` 这一个选项的结果，与选 `click` 是同一个决策。

**唯一的结构性约束**写在系统提示里而不是 schema 里（`system_prompt.md:131`）：

```
- You are ONLY ALLOWED to call `done` as a single action. Don't call it together with other actions.
```

（`action` 是 `list[ActionModel]`，一步最多 `max_actions_per_step` 个；默认 `max_actions_per_step: int = 5`，`browser_use/agent/views.py:71`。）

### 3.3 系统提示里管「判断任务是否完成」的段落（逐字）

**读到的原文。** `browser-use@d5453ae browser_use/agent/system_prompts/system_prompt.md:120-154`，整块原文照抄：

```
<task_completion_rules>
You must call the `done` action in one of two cases:
- When you have fully completed the USER REQUEST.
- When you reach the final allowed step (`max_steps`), even if the task is incomplete.
- If it is ABSOLUTELY IMPOSSIBLE to continue.
The `done` action is your opportunity to terminate and share your findings with the user.
- Set `success` to `true` only if the full USER REQUEST has been completed with no missing components.
- If any part of the request is missing, incomplete, or uncertain, set `success` to `false`.
- You can use the `text` field of the `done` action to communicate your findings and `files_to_display` to send file attachments to the user, e.g. `["results.md"]`.
- Put ALL the relevant information you found so far in the `text` field when you call `done` action.
- Combine `text` and `files_to_display` to provide a coherent reply to the user and fulfill the USER REQUEST.
- You are ONLY ALLOWED to call `done` as a single action. Don't call it together with other actions.
- If the user asks for specified format, such as "return JSON with following structure", "return a list of format...", MAKE sure to use the right format in your answer.
- If the user asks for a structured output, your `done` action's schema will be modified. Take this schema into account when solving the task!
- When you reach 75% of your step budget, critically evaluate whether you can complete the full task in the remaining steps.
  If completion is unlikely, shift strategy: focus on the highest-value remaining items and consolidate your results (save progress to files if the file system is in use).
  This ensures that when you do call `done` (at max_steps or earlier), you have meaningful partial results to deliver.
- For large multi-item tasks (e.g. "search 50 items"), estimate the per-item cost from the first few items.
  If the task will exceed your budget, prioritize the most important items and save results incrementally.
<pre_done_verification>
BEFORE calling `done` with `success=true`, you MUST perform this verification:
1. **Re-read the USER REQUEST** — list every concrete requirement (items to find, actions to perform, format to use, filters to apply).
2. **Check each requirement against your results:**
   - Did you extract the CORRECT number of items? (e.g., "list 5 items" → count them)
   - Did you apply ALL specified filters/criteria? (e.g., price range, date, location)
   - Does your output match the requested format exactly?
3. **Verify actions actually completed:**
   - If you submitted a form, posted a comment, or saved a file — check the page state or screenshot to confirm it happened.
   - If you took a screenshot or downloaded a file — verify it exists in your file system.
4. **Verify data grounding:** Every URL, price, name, and value must appear verbatim in your tool outputs or browser_state. Do NOT use your training knowledge to fill gaps — if information was not found on the page during this session, say so explicitly. Never fabricate or invent values.
5. **Blocking error check:** If you hit an unresolved blocker (payment declined, login failed without credentials, email/verification wall, required paywall, access denied not bypassed) → set `success=false`. Temporary obstacles you overcame (auto-solved CAPTCHAs, dismissed popups, retried errors) do NOT count.
6. **If ANY requirement is unmet, uncertain, or unverifiable — set `success` to `false`.**
   Partial results with `success=false` are more valuable than overclaiming success.
</pre_done_verification>
</task_completion_rules>
```

另有三处相关：

`system_prompt.md:118`（在 `<planning>` 块内）：

```
Completing all plan items does NOT mean the task is done. Always verify against the original <user_request> before calling `done`.
```

`system_prompt.md:196-197`（在 `<reasoning_rules>` 块内）：

```
- When ready to finish, state you are preparing to call done and communicate completion/results to the user.
- Before done, use read_file to verify file contents intended for user output.
```

`system_prompt.md:187`（同块，管的是「上一步成功了吗」）：

```
- Explicitly judge success/failure/uncertainty of the last action. Never assume an action succeeded just because it appears to be executed in your last step in <agent_history>. For example, you might have "Action 1/1: Input '2025-05-05' into element 3." in your history even though inputting text failed. Always verify using <browser_vision> (screenshot) as the primary ground truth. If a screenshot is unavailable, fall back to <browser_state>. If the expected change is missing, mark the last action as failed (or uncertain) and plan a recovery.
```

对比：面向自家微调模型的精简提示（`system_prompt_browser_use.md`，全文 18 行）**整块 `<task_completion_rules>` 都不存在**——只剩输出格式与一句数据接地要求：

```
<output>
You must ALWAYS respond with a valid JSON in this exact format:
{{
  "thinking": "A structured reasoning block analyzing: current page state, what was attempted, what worked/failed, and strategic planning for next steps.",
  "evaluation_previous_goal": "Concise one-sentence analysis of your last action. Clearly state success, failure, or uncertain.",
  "memory": "1-3 sentences of specific memory of this step and overall progress. Track items found, pages visited, forms filled, etc.",
  "next_goal": "State the next immediate goal and action to achieve it, in one clear sentence.",
  "action": [{{"action_name": {{...params...}}}}]
}}
Action list should NEVER be empty.
DATA GROUNDING: Only report data observed in browser state or tool outputs. Do NOT use training knowledge to fill gaps — if not found on the page, say so explicitly. Never fabricate values.
</output>
```

**我的推断。** browser-use 把「是不是已经到了」的全部重量压在**自然语言的检查清单**上（`<pre_done_verification>` 六条，约 300 词），而不是压在 schema 上。schema 那侧只提供了一个 `success: bool`，而且它是 `default=True`——即模型不写就是 True。清单的第 6 条（"If ANY requirement is unmet, uncertain, or unverifiable — set `success` to `false`."）正是用文字去抵消这个默认值。

### 3.4 别的形状

#### 3.4.1 独立的模型调用（browser-use 曾经有，已删除）

**读到的原文。** 在 `browser-use` tag `0.1.40` 的 `browser_use/agent/service.py:688-731`，有一个独立的 validator 调用，逐字：

```python
async def _validate_output(self) -> bool:
    """Validate the output of the last action is what the user wanted"""
    system_msg = (
        f'You are a validator of an agent who interacts with a browser. '
        f'Validate if the output of last action is what the user wanted and if the task is completed. '
        f'If the task is unclear defined, you can let it pass. But if something is missing or the image does not show what was requested dont let it pass. '
        f'Try to understand the page and help the model with suggestions like scroll, do x, ... to get the solution right. '
        f'Task to validate: {self.task}. Return a JSON object with 2 keys: is_valid and reason. '
        f'is_valid is a boolean that indicates if the output is correct. '
        f'reason is a string that explains why it is valid or not.'
        f' example: {{"is_valid": false, "reason": "The user wanted to search for "cat photos", but the agent searched for "dog photos" instead."}}'
    )
    ...
    class ValidationResult(BaseModel):
        """
        Validation results.
        """

        is_valid: bool
        reason: str

    validator = self.llm.with_structured_output(ValidationResult, include_raw=True)
    response: dict[str, Any] = await validator.ainvoke(msg)  # type: ignore
    parsed: ValidationResult = response['parsed']
    is_valid = parsed.is_valid
    if not is_valid:
        logger.info(f'❌ Validator decision: {parsed.reason}')
        msg = f'The output is not yet correct. {parsed.reason}.'
        self.state.last_result = [ActionResult(extracted_content=msg, include_in_memory=True)]
    else:
        logger.info(f'✅ Validator decision: {parsed.reason}')
    return is_valid
```

它是**默认关闭**的（`0.1.40 browser_use/agent/service.py:105`：`validate_output: bool = False,`），并且是一个真正的**闸门**——不通过就不算 done，失败原因被写回 `last_result` 让 agent 继续（`0.1.40 service.py:559-560`、`:603-604`）：

```python
if self.settings.validate_output:
    if not await self._validate_output():
```

在 `browser-use@d5453ae` 里，`validate_output` / `_validate_output` / `ValidationResult` **全部不存在**（对 `browser_use/` 全目录 grep，唯一形似的命中是 `browser_use/skills/install.py:138` 的 `_validate_output_paths`，与此无关）。取而代之的是 `judge`，它在 `done` 之后跑，并且**不覆盖**模型的自评：

`browser-use@d5453ae browser_use/agent/service.py:1628-1634`

```python
async def _judge_and_log(self) -> None:
    """Run judge evaluation and log the verdict.

    The judge verdict is attached to the action result but does NOT override
    last_result.success — that stays as the agent's self-report. Telemetry
    sends both values so the eval platform can compare agent vs judge.
    """
```

判官的评分框架（`browser_use/agent/judge.py:110-119`）：

```
**PRIMARY EVALUATION CRITERIA (in order of importance):**
1. **Task Satisfaction (Most Important)**: Did the agent accomplish what the user asked for? Break down the task into the key criteria and evaluate if the agent all of them. Focus on user intent and final outcome.
2. **Output Quality**: Is the final result in the correct format and complete? Does it match exactly what was requested?
...
**VERDICT GUIDELINES:**
- true: Task completed as requested, human-like execution, all of the users criteria were met and the agent did not make up any information.
- false: Task not completed, or only partially completed.
```

调用点：`browser_use/agent/service.py:2278` 与 `:2489`，均在 `is_done` 之后。开关 `use_judge: bool = True`（`browser_use/agent/views.py:74`）。

**我的推断。** browser-use 走过一遍「独立模型调用当闸门」，现在把它降级成了「事后打分、只用于遥测和日志」。代码注释里说明的理由只到「so the eval platform can compare agent vs judge」为止，没有说明为什么不再当闸门。**改动的动机在原文里查不到**（见 §4）。

#### 3.4.2 强制分类塞进选项里（Mind2Web）

**读到的原文。** 「以上都不是」是**选项 A**，不是一个额外字段（`Mind2Web@33bd95c src/action_prediction/dataloader.py:106-110`）：

```python
seq_input += (
    "What should be the next action? Please select from the following choices "
    "(If the correct action is not in the page above, please select A. 'None of the above'):\n\n"
    "A. None of the above\n"
)
```

生成式（非多选）变体里则是一句硬性指令（`dataloader.py:53-57`）：

```python
seq_input += (
    "What should be the next action?"
    "Please select the element to interact with, and the action to perform along with the value to type in or select. "
    "If the task cannot be completed, output None."
)
```

**我的推断。** 这是把「我做不到／不在这一页」做成了**与所有正常选项同一层的一个具名选项**，而且是排在第一位的 A。它逼的是「本页有没有」而不是「目标有没有达成」——两者不同，但形状上是「先分类再动作」的一种。

#### 3.4.3 事后的多模态判官（WebVoyager）

**读到的原文。** `WebVoyager@5a78967 evaluation/auto_eval.py` 的 SYSTEM_PROMPT 结尾：

```
You should elaborate on how you arrived at your final evaluation and then provide a definitive verdict on whether the task has been successfully accomplished, either as 'SUCCESS' or 'NOT SUCCESS'.
```

论文摘要里对应的指标：「The proposed automatic evaluation metric achieves 85.3% agreement with human judgment」（arXiv:2401.13919，Abstract）。

这同样是**事后**的、用于评测的独立调用，不参与 agent 循环内的决策。agent 循环内的达成判断只有一句提示（`prompts.py:8`）：

```
7. Answer. This action should only be chosen when all questions in the task have been solved.
```

和一条守则（`prompts.py:26`）：

```
5) When a complex Task involves multiple questions or steps, select "ANSWER" only at the very end, after addressing all of these questions (steps). Flexibly combine your own abilities with the information in the web page. Double check the formatting requirements in the task when ANSWER. 
```

#### 3.4.4 断言工具（Playwright MCP）

**读到的原文。** Playwright MCP 没有自己的 agent 循环、没有系统提示，达成判断完全在宿主模型侧。但它提供了一组 `type: 'assertion'` 的工具，让宿主可以显式核对页面状态：

`playwright@46cd500 packages/playwright-core/src/tools/backend/verify.ts:24-36`

```ts
const verifyElement = defineTabTool({
  capability: 'testing',
  schema: {
    name: 'browser_verify_element_visible',
    title: 'Verify element visible',
    description: 'Verify element is visible on the page',
    inputSchema: z.object({
      role: z.string().describe('ROLE of the element. Can be found in the snapshot like this: \`- {ROLE} "Accessible Name":\`'),
      accessibleName: z.string().describe('ACCESSIBLE_NAME of the element. Can be found in the snapshot like this: \`- role "{ACCESSIBLE_NAME}"\`'),
    }),
    type: 'assertion',
  },
```

同组还有 `browser_verify_text_visible`、`browser_verify_list_visible`、`browser_verify_value`。它们的 `capability` 是 `'testing'`——**面向测试生成，不是面向 agent 的达成判断**。核对失败时返回的是 error（`verify.ts:48`：`response.addError(...)`）。

#### 3.4.5 用 `tool_choice` 强制？

**读到的原文。** browser-use 在 provider 适配层用 `tool_choice` 强制「必须调用那一个 schema 工具」，而不是用它在多个语义工具间做选择：

- `browser_use/llm/groq/chat.py:200`：注释 `` `_invoke_with_tool_calling` sends tool_choice='required', so the model returns the payload as ``；`:227` `tool_choice: ChatCompletionToolChoiceOptionParam = 'required'`
- `browser_use/llm/anthropic/chat.py:439`：`tool_choice = ToolChoiceToolParam(type='tool', name=tool_name)`
- `browser_use/llm/deepseek/chat.py:179`：`tool_choice = {'type': 'function', 'function': {'name': tool_name}}`

**我的推断。** 这些 `tool_choice` 的用途是「把结构化输出跑在 tool-calling 通道上」——工具只有一个（`AgentOutput` 那个 schema），所以 `tool_choice` 在这里承担的是格式保证，不是语义分流。browser-use 从头到尾**没有把 `done` 做成一个可被 `tool_choice` 选中的独立工具**。本项目把 `guide` / `clarify` / `need_docs` / `done` 做成四个平级的函数，是这批来源里独一份的形状。

---

## 4. 没查到 / 无法确认

逐条列出我**没有**从一手来源找到答案的问题，不猜。

1. **browser-use 为什么把 `_validate_output` 从闸门降级为事后 judge。** 代码里没有说明；我读的是 depth-1 浅克隆，没有 commit 历史，也没有在仓库里找到相关 ADR 或设计文档。当前代码只说明 judge「does NOT override last_result.success」，没说为什么。
2. **40000 这个字符上限是怎么定的。** `browser_use/agent/prompts.py:117` 等三处只是一个裸的默认值，没有注释、没有测量记录。
3. **`viewport_threshold = 1000` 这个像素值是怎么定的。** 同上，`browser_use/dom/service.py:64` 无注释；docstring 只解释了它的语义（"Pixel threshold beyond viewport to consider visible"），没有解释为什么是 1000 而不是别的。
4. **browser-use 是否观察到过「点击 → 滚动 → 下一帧丢元素」这个正反馈。** 我在 `browser_use/dom/`、`browser_use/browser/watchdogs/` 全目录找过任何与「跨帧合并元素集合」「记住上一帧可见元素」相关的代码或注释，只找到 `previous_cached_state` 的 `*` 新元素标记用途。**没有任何证据表明他们处理过或讨论过这个问题**，也没有证据表明他们没遇到过。
5. **Playwright MCP 面对一个真实的大型页面（如 github.com 仓库页）时，`ai` 模式快照的实际 token 量。** 仓库测试用的都是几行 HTML 的合成页面，没有真实站点的 golden 输出。我没有实际运行它去测。
6. **是否存在「在动作之前强制一个布尔达成判断」的框架。** 我查了这四个来源的全部输出 schema 与系统提示，**没有找到**。最接近的三个形状分别是：browser-use 的字段顺序（反思字段在 `action` 之前，但问的是过去和未来，不是「现在是否已达成」）、Mind2Web 的 "A. None of the above"（问的是「本页有没有」）、以及 browser-use 已删除的 `_validate_output`（是独立调用，且在 `done` 之后而非之前）。我没有系统地检索这四个之外的框架，所以这不是一个「不存在」的结论，只是「在这四个一手来源里不存在」。
7. **WebVoyager 论文是否明文写了「只标注视口内元素」。** §3.3 我通过 ar5iv 全文检索没有找到这句话的明文；「视口内」是我从注入脚本（`utils.py:60-64`，`document.elementFromPoint` + `area >= 20`）推出来的，已在 §2.3 标为推断。
8. **browser-use 系统提示第 61 行写 `|SCROLL|`、实现生成 `|scroll element|`** 这处不一致是有意还是笔误，无法从原文确认。

---

## 5. 与本项目现状的事实并置（不含建议）

只陈述可对照的事实差异，出处均在上文。

| 维度 | 本项目 | 上述来源 |
|---|---|---|
| 预算单位 | 元素条数（`budgetFor`：`contextWindow <= 64_000 ? 150 : 250`，`project.ts:27-30`） | browser-use 是字符数 40000；Playwright MCP 无；Mind2Web 是候选条数 50 |
| 丢弃方式 | 打分排序取 top-N 后恢复文档顺序（`project.ts:163-168`） | browser-use 尾部切片；Mind2Web 模型排序；Playwright MCP 不丢 |
| 打分是否看目标 | 否（`score()` 的输入只有 `UINode` 与 `LocatorView`，`project.ts:182-190`） | 只有 Mind2Web 看（query 含 task + previous actions） |
| 视口的地位 | 偏好（`project.ts:172-181` 注释明写「Proximity to the viewport is a *preference*, not a filter.」） | browser-use 是硬过滤；WebVoyager 是硬过滤；Playwright MCP 无 |
| 是否告知被截断 | 是（`toPromptText` 输出 `truncated 这一页还有更多元素没有列出…`，`project.ts:365`） | browser-use 输出 `Interactive elements (truncated to 40000 characters):`；另有 `<page_info>` / `[Start/End of page]` |
| 输出契约形状 | 四个平级 function（`guide`/`clarify`/`need_docs`/`done`），`strict: true`，`steps[].ref` 是 enum | browser-use 一个 schema，`done` 是 action 列表里的一项；Mind2Web 是字母多选；WebVoyager 是文本格式约定 |
| 强制分类字段 | `previous_step`（`first_plan`/`worked`/`no_change`）+ `done.evidence`（`content_on_page`/`page_address`/`step_completed`） | browser-use 三个自由文本必填字段，无枚举；`done.success: bool` 默认 True |
| 达成判断写在哪 | tool `description`（`agent.ts` 的 `done` 描述 + `TOOL_CHOICE_POLICY`） | browser-use 全部写在 `system_prompt.md` 的 `<task_completion_rules>` / `<pre_done_verification>`，Pydantic 字段无 description |
| 是否有独立的达成判官 | 无 | browser-use 有事后 judge（不覆盖自评）；WebVoyager 有事后 GPT-4V 判官（仅评测）；两者都不在循环内当闸门 |
| 滚动 | 高亮时调 `scrollIntoView`，模型的 `action` 枚举含 `scroll` | browser-use 有 scroll 动作 + `scrollIntoViewIfNeeded`；Playwright MCP 无 scroll 工具 |

---

## 6. 引用速查

**browser-use@d5453ae**（v0.13.10，2026-09-04）
`browser_use/dom/service.py:64` `:80-148` `:252-353` `:952-954` ·
`browser_use/dom/views.py:18-82` `:942-955` ·
`browser_use/dom/serializer/serializer.py:44-61` `:114-165` `:455-560` `:772-882` `:989-1201` `:1204-` ·
`browser_use/agent/prompts.py:59-91` `:117` `:155-335` ·
`browser_use/agent/views.py:70-80` `:381-472` ·
`browser_use/agent/service.py:210` `:1593-1670` `:2278` `:2489` ·
`browser_use/agent/judge.py:110-119` ·
`browser_use/agent/message_manager/service.py:480-566` ·
`browser_use/agent/system_prompts/system_prompt.md:30-63` `:75` `:110-154` `:181-199` `:232-245` ·
`browser_use/agent/system_prompts/system_prompt_browser_use.md`（全 18 行）·
`browser_use/tools/service.py:1379-1382` `:1503` `:2008-2088` ·
`browser_use/tools/views.py:89-101` `:130-133` ·
`browser_use/browser/watchdogs/default_action_watchdog.py:766-774` ·
`browser_use/llm/groq/chat.py:200` `:227`、`browser_use/llm/anthropic/chat.py:439`、`browser_use/llm/deepseek/chat.py:179`

**browser-use@tag 0.1.40**
`browser_use/agent/service.py:105` `:559-560` `:603-604` `:688-731`

**playwright@46cd500**（对应 @playwright/mcp 0.0.80，2026-09-04）
`packages/playwright-core/src/tools/backend/snapshot.ts:24-56` `:76-95` ·
`packages/playwright-core/src/tools/backend/response.ts:155-165` `:237-266` `:267-340` ·
`packages/playwright-core/src/tools/backend/find.ts:30-70` ·
`packages/playwright-core/src/tools/backend/verify.ts:24-75` ·
`packages/playwright-core/src/tools/backend/tab.ts:423-437` ·
`packages/injected/src/ariaSnapshot.ts:40-78` `:196-232` `:236-275` ·
`packages/injected/src/ariaSnapshotDistiller.ts:23-31` `:143-263` ·
`packages/injected/src/domUtils.ts:120-143` ·
`packages/isomorphic/ariaSnapshotRenderer.ts:27-120` ·
`packages/playwright-core/src/tools/skills/playwright-cli/SKILL.md:267-305` ·
`tests/mcp/core.spec.ts:26-30` `:194-197` `:308-328` ·
`tests/mcp/snapshot-mode.spec.ts:21-118` ·
`tests/mcp/test-debug.spec.ts:144-164`
（playwright-mcp@8a13ef8 本体：`src/README.md`、`package.json`、`index.js`、`tests/core.spec.ts:19-27`、`tests/click.spec.ts:30-48`）

**WebVoyager@5a78967**（2024-03-04；论文 arXiv:2401.13919 v4，ACL 2024 main，§3.3 / §3.4 / Abstract）
`prompts.py:1-40`（SYSTEM_PROMPT）`:42-80`（SYSTEM_PROMPT_TEXT_ONLY）·
`utils.py:39-175`（markPage 注入脚本）`:178-210`（格式化）`:258-301`（上下文裁剪）`:333-345`（text-only AX 树，`current_viewport_only=True`）·
`run.py:209-227`（scroll 执行）`:327` `:353` ·
`evaluation/auto_eval.py`（SYSTEM_PROMPT）

**Mind2Web@33bd95c**（2025-11-04；论文 arXiv:2306.06070 v3，NeurIPS'23 Spotlight，§3 Method: MindAct / §4.3）
`README.md:138-162` `:186-191` `:243-248` ·
`src/candidate_generation/dataloader.py:20-74` ·
`src/action_prediction/dataloader.py:20-124` `:133-190` ·
`src/action_prediction/metric.py:88` `:121` `:140-147` ·
`src/action_prediction/conf/config.yaml` ·
`src/action_prediction/llm_prompt.json` ·
`src/data_utils/dom_utils.py:203-248`
