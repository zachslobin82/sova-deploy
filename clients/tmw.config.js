const clientConfig = {
  businessName: "Therapeutic Massage & Wellness",
  agentName: "Maya",
  locationId: "i354kGTSmTlt3zeEVsCG",
  calendars: {
    25:  "uBLikuiy9gCI2MDItdz5",
    55:  "HFlTUh76tUn01FHsf9Hi",
    85:  "GDhkZy8h9CtjAOPPKlgR",
    110: "tFKqGwFxE5Ka5626we5X"
  },
  ghlBearerToken: process.env.GHL_BEARER_TOKEN || "pit-fb11d1b0-f062-492e-a5a7-c51b09e1d9cb",
  // Retell posts booking data here — Railway endpoint
  bookingWebhookUrl: "https://sova-deploy-production.up.railway.app/create-ghl-booking",
  voiceId: "custom_voice_b315a4ce2cf96a8aa40254b66e",
  llmModel: "gpt-4.1",
  timezone: "America/New_York"
};

module.exports = clientConfig;
