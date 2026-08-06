"""Reinforcement-learning price agent (contextual bandit / Q-learning).

The agent treats price setting as a sequential decision problem: the market state
(inventory, demand pressure, competitor gap) is discretised into buckets, and the
agent learns a Q-table over candidate price *actions* (multipliers around the
recommended price). Each episode it picks an action (epsilon-greedy), observes a
reward = revenue - holding_cost_penalty, and updates Q. This lets the price
"continuously adapt" to changing market conditions without re-training the demand
regressor.

Implemented with numpy only (no TensorFlow) so it runs anywhere.
"""
from __future__ import annotations

import numpy as np

# price action multipliers applied to the recommended (base) price
ACTION_MULTIPLIERS = np.array([0.85, 0.92, 1.0, 1.08, 1.15], dtype=float)

N_INV_BINS = 3
N_PRESSURE_BINS = 3
N_GAP_BINS = 3
N_ACTIONS = len(ACTION_MULTIPLIERS)


def _bins(values: np.ndarray, n: int) -> np.ndarray:
    """Discretise continuous values into 0..n-1 equal-width bins."""
    vmin, vmax = float(np.min(values)), float(np.max(values))
    if vmax - vmin < 1e-9:
        return np.zeros(len(values), dtype=int)
    edges = np.linspace(vmin, vmax, n + 1)
    return np.clip(np.digitize(values, edges[1:-1]), 0, n - 1)


class PriceAgent:
    """Q-learning agent over (inventory, demand_pressure, competitor_gap) states."""

    def __init__(self, alpha: float = 0.15, gamma: float = 0.9,
                 epsilon: float = 0.2, seed: int = 42) -> None:
        self.alpha = alpha
        self.gamma = gamma
        self.epsilon = epsilon
        self.rng = np.random.default_rng(seed)
        self.q = np.zeros((N_INV_BINS, N_PRESSURE_BINS, N_GAP_BINS, N_ACTIONS))
        self.steps = 0

    def state_index(self, inventory: float, demand_pressure: float,
                    competitor_gap: float) -> tuple[int, int, int]:
        inv = _bins(np.array([inventory]), N_INV_BINS)[0]
        pre = _bins(np.array([demand_pressure]), N_PRESSURE_BINS)[0]
        gap = _bins(np.array([competitor_gap]), N_GAP_BINS)[0]
        return int(inv), int(pre), int(gap)

    def pick_action(self, state: tuple[int, int, int], greedy: bool = False) -> int:
        s = state
        if not greedy and self.rng.random() < self.epsilon:
            return int(self.rng.integers(N_ACTIONS))
        return int(np.argmax(self.q[s]))

    def update(self, state: tuple[int, int, int], action: int, reward: float,
               next_state: tuple[int, int, int]) -> None:
        s, n = state, next_state
        td = reward + self.gamma * float(np.max(self.q[n])) - self.q[s][action]
        self.q[s][action] += self.alpha * td
        self.steps += 1


def simulated_reward(multiplier: float, inventory: float, demand_pressure: float,
                     cost: float, base_price: float, elasticity: float) -> float:
    """Revenue proxy: demand shrinks as price rises, capped by inventory, minus
    holding cost on leftover stock. The agent learns to balance price vs sales."""
    price = base_price * multiplier
    demand = 40 * np.exp(elasticity * (price - base_price) / base_price)
    demand *= 1 + 0.5 * demand_pressure
    sold = min(demand, inventory)
    leftover = max(inventory - demand, 0)
    return price * sold - 0.2 * cost * leftover


def train_agent(episodes: int = 2000, seed: int = 42) -> PriceAgent:
    rng = np.random.default_rng(seed)
    agent = PriceAgent(seed=seed)
    for _ in range(episodes):
        inventory = float(rng.uniform(5, 150))
        pressure = float(rng.uniform(0, 1))
        gap = float(rng.uniform(-0.3, 0.3))
        cost = float(rng.uniform(2, 60))
        base = float(rng.uniform(10, 150))
        elasticity = float(rng.uniform(-2.2, -0.8))
        s = agent.state_index(inventory, pressure, gap)
        a = agent.pick_action(s)
        reward = simulated_reward(ACTION_MULTIPLIERS[a], inventory, pressure,
                                  cost, base, elasticity)
        # next state drifts slightly (market changes)
        n_inv = float(np.clip(inventory - rng.uniform(0, 5), 1, 200))
        n_press = float(np.clip(pressure + rng.normal(0, 0.05), 0, 1))
        n_gap = float(np.clip(gap + rng.normal(0, 0.02), -0.3, 0.3))
        n_s = agent.state_index(n_inv, n_press, n_gap)
        agent.update(s, a, reward, n_s)
    return agent


def recommend_price_rl(agent: PriceAgent, base_price: float, cost: float,
                       competitor_price: float, inventory: int,
                       demand_pressure: float, recommended_price: float) -> dict:
    gap = (recommended_price - competitor_price) / max(competitor_price, 1e-6)
    s = agent.state_index(inventory, demand_pressure, gap)
    a = agent.pick_action(s, greedy=True)
    multiplier = ACTION_MULTIPLIERS[a]
    price = round(recommended_price * multiplier, 2)
    return {
        "method": "rl",
        "product_state": {"inventory": inventory,
                          "demand_pressure": demand_pressure,
                          "competitor_gap": round(float(gap), 3)},
        "action_index": int(a),
        "action_multiplier": float(multiplier),
        "price": price,
        "q_values": [round(float(v), 4) for v in agent.q[s]],
        "learning_steps": agent.steps,
    }