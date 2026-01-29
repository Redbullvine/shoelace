exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const payload = JSON.parse(event.body || "{}");
  const manualParts = Array.isArray(payload.manualParts) ? payload.manualParts : [];

  const baseItems = [
    { part: "ADC-CL-102", category: "Closures", qtyEstimate: 12, confidence: 0.62, priceRange: "$80-$120" },
    { part: "COR-MST-8P", category: "MST", qtyEstimate: 6, confidence: 0.58, priceRange: "$250-$320" },
    { part: "FDH-144A", category: "FDH", qtyEstimate: 2, confidence: 0.67, priceRange: "$900-$1,200" },
    { part: "HW-KIT-778", category: "Hardware", qtyEstimate: 40, confidence: 0.54, priceRange: "$8-$15" },
  ];

  const manualItems = manualParts.map((part) => ({
    part,
    category: "Manual Entry",
    qtyEstimate: 1,
    confidence: 0.92,
    priceRange: "$100-$350",
  }));

  const items = [...manualItems, ...baseItems].slice(0, 6);
  const overallConfidence = items.reduce((sum, item) => sum + item.confidence, 0) / items.length;

  const result = {
    scanId: payload.scanId || null,
    detectedAt: new Date().toISOString(),
    overallConfidence,
    status: "Ready",
    sellFirstTags: ["High Demand", "Low Stock", "Contractor Favorite"],
    suggestedChannels: ["Telecom broker", "eBay", "Surplus wholesale"],
    items,
  };

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result),
  };
};
