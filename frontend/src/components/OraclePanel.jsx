import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { streamOracle } from "../api/client";

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseMentions(text) {
  const matches = text.match(/@[\w\s-]+(?=\s|$|[^a-zA-Z0-9\s-])/g) ?? [];
  return matches.map((match) => match.slice(1).trim());
}

function resolveMentions(mentionNames, bags) {
  const seen = new Set();
  const orderedBags = [...bags].sort((left, right) => right.name.length - left.name.length);

  return mentionNames
    .map((name) => {
      const normalized = name.toLowerCase();
      return orderedBags.find((bag) => {
        const bagName = bag.name.toLowerCase();
        return bagName === normalized
          || bagName.includes(normalized)
          || normalized.startsWith(`${bagName} `)
          || normalized.includes(` ${bagName} `)
          || normalized.endsWith(` ${bagName}`);
      });
    })
    .filter((bag) => {
      if (!bag || seen.has(bag.id)) {
        return false;
      }
      seen.add(bag.id);
      return true;
    });
}

function buildInitialMessage(selectedNodes, activeBag) {
  if (activeBag?.nodeIds?.length) {
    return `Bag "${activeBag.name}" is active. Ask about contradictions, validation risk, or use @mentions to compare it with other bags.`;
  }

  if (selectedNodes.length > 0) {
    return `I have ${selectedNodes.length} grounded node${selectedNodes.length > 1 ? "s" : ""}. Ask for contradictions, provenance, experiments, or validation risk.`;
  }

  return "Select nodes, activate a bag, or @mention a bag by name.";
}

function renderUserContent(text) {
  return escapeHtml(text).replace(/\n/g, "<br/>");
}

function renderAssistantContent(text) {
  let html = escapeHtml(text);

  html = html.replace(
    /\[NODE: ([^\]]+)\]/g,
    (_, citation) => (
      `<span style="background:rgba(77,124,255,0.1);border:1px solid rgba(77,124,255,0.3);color:#4d7cff;font-size:10px;padding:1px 6px;margin:0 2px;display:inline-block">NODE ${citation.split("|")[0].trim()}</span>`
    ),
  );

  html = html.replace(
    /\[CONTRA: ([^\]]+)\]/g,
    (_, citation) => (
      `<span style="background:rgba(255,100,50,0.1);border:1px solid rgba(255,100,50,0.3);color:#ffb340;font-size:10px;padding:1px 6px;margin:0 2px;display:inline-block">CONTRA ${citation}</span>`
    ),
  );

  html = html.replace(
    /@([\w\s-]+)/g,
    (_, name) => (
      `<span style="background:rgba(0,229,160,0.1);border:1px solid rgba(0,229,160,0.25);color:#00e5a0;font-size:10px;padding:1px 7px;margin:0 2px;display:inline-block">@${name.trim()}</span>`
    ),
  );

  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return html.replace(/\n/g, "<br/>");
}

export default function OraclePanel({
  selectedNodes = [],
  sessionId,
  activeBag = null,
  allNodes = [],
  bags = [],
}) {
  const [messages, setMessages] = useState(() => [
    {
      role: "assistant",
      content: buildInitialMessage(selectedNodes, activeBag),
    },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [mentionSearch, setMentionSearch] = useState(null);
  const [mentionAnchor, setMentionAnchor] = useState(0);
  const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const allNodeMap = useMemo(
    () => Object.fromEntries(allNodes.map((node) => [node.node_id, node])),
    [allNodes],
  );

  const mentionCandidates = useMemo(() => {
    if (mentionSearch === null) {
      return [];
    }

    const query = mentionSearch.trim().toLowerCase();
    return bags
      .filter((bag) => !query || bag.name.toLowerCase().includes(query))
      .slice(0, 6);
  }, [bags, mentionSearch]);

  const suggestedPrompts = useMemo(() => (
    bags.length > 0
      ? [
          `@${bags[0].name} summarize the validation risk`,
          `@${bags[0].name} what experiments resolve the top contradiction?`,
          bags.length > 1
            ? `Compare @${bags[0].name} vs @${bags[1].name}`
            : `@${bags[0].name} private data vs literature`,
          `@${bags[0].name} friction score breakdown`,
        ]
      : selectedNodes.length > 0
        ? [
            "Why is this cluster red?",
            "What does the private data say vs. the literature?",
            "What experiments would resolve the top contradiction?",
            "Summarize the target validation risk.",
          ]
        : []
  ), [bags, selectedNodes.length]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const nextInitial = buildInitialMessage(selectedNodes, activeBag);

    setMessages((current) => {
      if (current.length === 1 && current[0]?.role === "assistant" && current[0]?.content !== nextInitial) {
        return [{ role: "assistant", content: nextInitial }];
      }
      return current;
    });
  }, [activeBag, selectedNodes]);

  const resolveContext = useCallback((text) => {
    const mentionNames = parseMentions(text);
    const mentionedBags = resolveMentions(mentionNames, bags);
    const bagNodeIds = new Set(mentionedBags.flatMap((bag) => bag.nodeIds));

    if (activeBag) {
      activeBag.nodeIds.forEach((id) => bagNodeIds.add(id));
    }

    selectedNodes.forEach((node) => bagNodeIds.add(node.node_id));

    const contextNodes = allNodes.filter((node) => bagNodeIds.has(node.node_id));
    const bagMeta = mentionedBags.map((bag) => {
      const bagNodes = bag.nodeIds.map((id) => allNodeMap[id]).filter(Boolean);
      const frictions = bagNodes.map((node) => node.friction_score ?? 0);
      return {
        name: bag.name,
        node_count: bagNodes.length,
        avg_friction: frictions.length
          ? (frictions.reduce((sum, value) => sum + value, 0) / frictions.length).toFixed(2)
          : 0,
        critical: frictions.filter((value) => value >= 0.85).length,
        high: frictions.filter((value) => value >= 0.6).length,
        private_nodes: bagNodes.filter((node) => node.source_type === "private_csv").length,
        public_nodes: bagNodes.filter((node) => node.source_type === "public_abstract").length,
      };
    });

    return {
      contextNodes,
      mentionedBags,
      bagMeta,
      isBagQuery: mentionedBags.length > 0 || !!activeBag,
      bagNames: mentionedBags.map((bag) => bag.name),
    };
  }, [activeBag, allNodeMap, allNodes, bags, selectedNodes]);

  const acceptMention = useCallback((bag) => {
    const before = input.slice(0, mentionAnchor);
    const after = input.slice(mentionAnchor).replace(/@[\w\s-]*/, `@${bag.name} `);
    const nextValue = before + after;
    const nextCursor = before.length + bag.name.length + 2;

    setInput(nextValue);
    setMentionSearch(null);
    setSelectedMentionIdx(0);

    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }, [input, mentionAnchor]);

  const handleInputChange = useCallback((event) => {
    const value = event.target.value;
    setInput(value);
    const cursor = event.target.selectionStart;
    const textUpToCursor = value.slice(0, cursor);
    const mentionMatch = textUpToCursor.match(/@([\w\s-]*)$/);

    if (mentionMatch) {
      const fragment = mentionMatch[1];
      const normalizedFragment = fragment.trim().toLowerCase();
      const resolvedBag = [...bags]
        .sort((left, right) => right.name.length - left.name.length)
        .find((bag) => normalizedFragment.startsWith(`${bag.name.toLowerCase()} `));

      if (resolvedBag) {
        setMentionSearch(null);
        return;
      }

      setMentionSearch(fragment);
      setMentionAnchor(mentionMatch.index);
      setSelectedMentionIdx(0);
    } else {
      setMentionSearch(null);
    }
  }, [bags]);

  const send = useCallback(async (text) => {
    if (!text.trim() || isStreaming) {
      return;
    }

    const { contextNodes, mentionedBags, bagMeta, isBagQuery, bagNames } = resolveContext(text);
    if (contextNodes.length === 0 && selectedNodes.length === 0) {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: "No context loaded. Select nodes, activate a bag, or @mention a bag by name.",
        },
      ]);
      return;
    }

    const userMessage = {
      role: "user",
      content: text,
      mentions: mentionedBags.map((bag) => ({
        name: bag.name,
        color: bag.color,
        nodeCount: bag.nodeIds.length,
      })),
    };

    const history = [...messages, userMessage];
    setInput("");
    setMentionSearch(null);
    setIsStreaming(true);

    let augmentedText = text;
    if (bagMeta.length > 0) {
      const bagContext = bagMeta.map((bag) => (
        `[BAG @${bag.name}: ${bag.node_count} nodes, avg friction ${bag.avg_friction}, ${bag.critical} critical, ${bag.high} high, ${bag.private_nodes} private / ${bag.public_nodes} literature]`
      )).join("\n");
      augmentedText = `${text}\n\n${bagContext}`;
    }

    const apiMessages = history.map((message, index) => ({
      role: message.role,
      content: message.role === "user" && index === history.length - 1 ? augmentedText : message.content,
    }));

    setMessages([...history, { role: "assistant", content: "" }]);

    const requestBagName = isBagQuery ? (bagNames.join(", ") || activeBag?.name || null) : null;

    try {
      const body = await streamOracle(
        sessionId,
        contextNodes.map((node) => node.node_id),
        apiMessages,
        requestBagName,
      );

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        accumulated += decoder.decode(value, { stream: true });
        setMessages((current) => [
          ...current.slice(0, -1),
          { role: "assistant", content: accumulated },
        ]);
      }
    } catch (error) {
      setMessages((current) => [
        ...current.slice(0, -1),
        {
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
    }

    setIsStreaming(false);
    window.setTimeout(() => inputRef.current?.focus(), 100);
  }, [activeBag, isStreaming, messages, resolveContext, selectedNodes.length, sessionId]);

  const handleKeyDown = useCallback((event) => {
    if (mentionSearch !== null && mentionCandidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedMentionIdx((current) => Math.min(current + 1, mentionCandidates.length - 1));
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedMentionIdx((current) => Math.max(current - 1, 0));
        return;
      }

      if (event.key === "Tab" || (event.key === "Enter" && mentionSearch !== null)) {
        event.preventDefault();
        acceptMention(mentionCandidates[selectedMentionIdx]);
        return;
      }

      if (event.key === "Escape") {
        setMentionSearch(null);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey && mentionSearch === null) {
      event.preventDefault();
      void send(input);
    }
  }, [acceptMention, input, mentionCandidates, mentionSearch, selectedMentionIdx, send]);

  const contextSummary = useMemo(() => {
    const mentions = parseMentions(input);
    const resolved = resolveMentions(mentions, bags);
    if (resolved.length > 0) {
      return {
        text: `@mentions: ${resolved.map((bag) => bag.name).join(", ")}`,
        color: "#00e5a0",
      };
    }
    if (activeBag) {
      return {
        text: `Bag: ${activeBag.name} | ${activeBag.nodeIds.length} nodes`,
        color: "#00e5a0",
      };
    }
    if (selectedNodes.length > 0) {
      return {
        text: `${selectedNodes.length} nodes selected`,
        color: "#00e5a0",
      };
    }
    return {
      text: "Select nodes, activate a bag, or @mention one",
      color: "#3a4055",
    };
  }, [activeBag, bags, input, selectedNodes.length]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "#0c0e12",
        fontFamily: "'DM Mono', monospace",
      }}
    >
      <div
        style={{
          padding: "14px 18px",
          borderBottom: "1px solid #1e2430",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            border: "1px solid #00e5a0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: "#00e5a0",
            boxShadow: "0 0 10px rgba(0,229,160,0.15)",
          }}
        >
          AI
        </div>
        <span style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 15 }}>
          Oracle
        </span>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 9,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: "#00e5a0",
          }}
        >
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#00e5a0",
              boxShadow: "0 0 6px #00e5a0",
              animation: "pulse 2s infinite",
            }}
          />
          Grounded
        </div>
      </div>

      <div
        style={{
          padding: "7px 18px",
          background: "rgba(0,229,160,0.03)",
          borderBottom: "1px solid #1e2430",
          fontSize: 10,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            background: contextSummary.color === "#00e5a0" ? "rgba(0,229,160,0.1)" : "rgba(58,64,85,0.15)",
            border: `1px solid ${contextSummary.color === "#00e5a0" ? "rgba(0,229,160,0.2)" : "rgba(58,64,85,0.25)"}`,
            padding: "2px 8px",
            color: contextSummary.color,
          }}
        >
          Context
        </span>
        <span style={{ color: contextSummary.color }}>{contextSummary.text}</span>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "14px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} style={{ display: "flex", gap: 10 }}>
            <div
              style={{
                width: 22,
                height: 22,
                flexShrink: 0,
                border: `1px solid ${message.role === "assistant" ? "#00e5a0" : "#1e2430"}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                color: message.role === "assistant" ? "#00e5a0" : "#6b7590",
              }}
            >
              {message.role === "assistant" ? "AI" : "U"}
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 9,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  color: message.role === "assistant" ? "#00e5a0" : "#3a4055",
                  marginBottom: 5,
                }}
              >
                {message.role === "assistant" ? "Oracle" : "You"}
              </div>

              {message.role === "user" && message.mentions?.length > 0 && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                  {message.mentions.map((mention) => (
                    <span
                      key={mention.name}
                      style={{
                        background: `${mention.color}18`,
                        border: `1px solid ${mention.color}44`,
                        color: mention.color,
                        fontSize: 10,
                        padding: "2px 8px",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: mention.color,
                          display: "inline-block",
                        }}
                      />
                      @{mention.name}
                      <span style={{ color: `${mention.color}88` }}>{mention.nodeCount} nodes</span>
                    </span>
                  ))}
                </div>
              )}

              {message.role === "assistant" && isStreaming && index === messages.length - 1 && !message.content ? (
                <div style={{ display: "flex", gap: 4, padding: "4px 0" }}>
                  {[0, 1, 2].map((dotIndex) => (
                    <div
                      key={dotIndex}
                      style={{
                        width: 4,
                        height: 4,
                        borderRadius: "50%",
                        background: "#00e5a0",
                        opacity: 0.4,
                        animation: `typingPulse 1.2s ${dotIndex * 0.2}s ease-in-out infinite`,
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.7,
                    color: message.role === "assistant" ? "#e8eaf0" : "#6b7590",
                  }}
                  dangerouslySetInnerHTML={{
                    __html: message.role === "assistant"
                      ? renderAssistantContent(message.content)
                      : renderUserContent(message.content),
                  }}
                />
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {suggestedPrompts.length > 0 && !isStreaming && (
        <div style={{ padding: "10px 18px", borderTop: "1px solid #1e2430" }}>
          <div
            style={{
              fontSize: 9,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: "#3a4055",
              marginBottom: 8,
            }}
          >
            Suggested
          </div>
          {suggestedPrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => void send(prompt)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "none",
                border: "1px solid #1e2430",
                cursor: "pointer",
                color: "#6b7590",
                fontFamily: "'DM Mono', monospace",
                fontSize: 11,
                padding: "7px 12px",
                marginBottom: 4,
                transition: "all 0.15s",
              }}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      <div style={{ padding: "14px 18px", borderTop: "1px solid #1e2430" }}>
        <div style={{ position: "relative" }}>
          {mentionSearch !== null && mentionCandidates.length > 0 && (
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                left: 14,
                right: 14,
                background: "#0c0e12",
                border: "1px solid #00e5a0",
                boxShadow: "0 -8px 24px rgba(0,0,0,0.6)",
                zIndex: 100,
                marginBottom: 2,
              }}
            >
              <div
                style={{
                  padding: "6px 14px",
                  fontSize: 9,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  color: "#3a4055",
                  borderBottom: "1px solid #1e2430",
                }}
              >
                Bags
              </div>
              {mentionCandidates.map((bag, index) => {
                const bagNodes = bag.nodeIds.map((id) => allNodeMap[id]).filter(Boolean);
                const avgFriction = bagNodes.length
                  ? bagNodes.reduce((sum, node) => sum + (node.friction_score ?? 0), 0) / bagNodes.length
                  : 0;

                return (
                  <div
                    key={bag.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "9px 14px",
                      cursor: "pointer",
                      transition: "background 0.1s",
                      background: index === selectedMentionIdx ? "rgba(0,229,160,0.06)" : "transparent",
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      acceptMention(bag);
                    }}
                    onMouseEnter={() => setSelectedMentionIdx(index)}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: bag.color,
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, color: "#e8eaf0" }}>@{bag.name}</div>
                      <div style={{ fontSize: 10, color: "#3a4055" }}>
                        {bag.nodeIds.length} nodes | avg friction {(avgFriction * 100).toFixed(0)}%
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: "#3a4055" }}>Enter</div>
                  </div>
                );
              })}
            </div>
          )}

          <div
            style={{
              display: "flex",
              border: "1px solid #1e2430",
              background: "#050608",
              transition: "border-color 0.2s",
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={
                activeBag
                  ? `Ask about @${activeBag.name} or selected nodes...`
                  : "Ask about selected nodes or @mention a bag..."
              }
              disabled={isStreaming}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                color: "#e8eaf0",
                fontFamily: "'DM Mono', monospace",
                fontSize: 12,
                padding: "10px 12px",
                outline: "none",
                resize: "none",
                minHeight: 42,
                maxHeight: 120,
              }}
              rows={1}
            />
            <button
              type="button"
              onClick={() => void send(input)}
              disabled={!input.trim() || isStreaming}
              style={{
                background: "transparent",
                border: "none",
                borderLeft: "1px solid #1e2430",
                cursor: input.trim() && !isStreaming ? "pointer" : "not-allowed",
                color: input.trim() && !isStreaming ? "#00e5a0" : "#3a4055",
                padding: "0 14px",
                fontSize: 14,
                transition: "color 0.15s",
              }}
            >
              SEND
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes typingPulse { 0%,100% { opacity: 0.2; transform: scale(1); } 50% { opacity: 1; transform: scale(1.3); } }
      `}</style>
    </div>
  );
}
