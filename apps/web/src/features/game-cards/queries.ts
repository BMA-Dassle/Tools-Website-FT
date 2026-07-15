/** React-query key factory for the game-cards feature. */
export const gameCardKeys = {
  all: ["game-cards"] as const,
  verify: (accountNumber: string) => ["game-cards", "verify", accountNumber] as const,
};
