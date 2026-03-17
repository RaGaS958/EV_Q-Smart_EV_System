"""
EV_Q:? — FastAPI Backend  (google-adk 1.27.0)
All agents can call get_vehicle_status() to read live vehicle telemetry.
Run:  uvicorn server:app --reload --host 0.0.0.0 --port 8000
"""
import os, sys, asyncio, random, math, traceback, uuid, json
from datetime import datetime
from typing import Optional, List, Any, Dict
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── API key ───────────────────────────────────────────────────────────────────
try:
    GOOGLE_API_KEY: str =os.getenv("API_KEY")
    print(f"✅  api.py loaded (key len={len(GOOGLE_API_KEY)})")
except Exception as exc:
    GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
    print(f"⚠️   api.py error ({exc}) — key len={len(GOOGLE_API_KEY)}")

app = FastAPI(title="EV_Q API", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# ══════════════════════════════════════════════════════════════════════════════
#  MESSAGE BROKER — async queue decouples chat processing from HTTP responses
#  Architecture:
#    POST /api/chat  →  enqueue job  →  return job_id immediately
#    GET  /api/chat/{job_id} →  poll result (or SSE stream)
#    Background worker drains queue one at a time (respects Gemini rate limits)
# ══════════════════════════════════════════════════════════════════════════════
import asyncio as _aio
from collections import OrderedDict

class _Broker:
    """
    Lightweight asyncio-based message broker.
    - Jobs are enqueued and processed FIFO by a single background worker.
    - Each job has a Future; the HTTP endpoint awaits it with a timeout.
    - This prevents request pile-ups and respects Gemini rate limits.
    """
    def __init__(self, max_results: int = 100):
        self._q:       _aio.Queue               = _aio.Queue()
        self._results: OrderedDict              = OrderedDict()
        self._max_results = max_results
        self._worker_task = None

    async def start(self):
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = _aio.ensure_future(self._worker())
            print("✅  Broker worker started")

    async def enqueue(self, job_id: str, coro) -> str:
        """Put a coroutine on the queue. Returns job_id."""
        fut = _aio.get_event_loop().create_future()
        await self._q.put((job_id, coro, fut))
        self._results[job_id] = fut
        # Trim oldest results
        while len(self._results) > self._max_results:
            self._results.popitem(last=False)
        return job_id

    async def get_result(self, job_id: str, timeout: float = 90.0):
        """Await the result of a job. Raises TimeoutError if too slow."""
        fut = self._results.get(job_id)
        if fut is None:
            raise KeyError(f"Job {job_id} not found")
        return await _aio.wait_for(_aio.shield(fut), timeout=timeout)

    async def _worker(self):
        """Single worker — processes jobs one at a time, no parallel Gemini calls."""
        print("✅  Broker worker listening…")
        while True:
            try:
                job_id, coro, fut = await self._q.get()
                try:
                    result = await coro
                    if not fut.done():
                        fut.set_result(result)
                except Exception as exc:
                    if not fut.done():
                        fut.set_exception(exc)
                finally:
                    self._q.task_done()
            except Exception as ex:
                print(f"⚠️  Broker worker error: {ex}")
                await _aio.sleep(0.5)

broker = _Broker()

# ── Globals ───────────────────────────────────────────────────────────────────
_runner:      Any  = None
_agent_ok:    bool = False
_init_error:  str  = "Not yet initialised"
_query_count: int  = 0
_agent_hits:  dict = {}
_session_history: List = []
_USER_ID = "evq_user"

# ── Live vehicle snapshot ─────────────────────────────────────────────────────
_vehicle_state: Dict = {}

# ── Active drive mode (toggled by frontend) ───────────────────────────────────
_active_mode: str = "NORMAL"
_emergency_log: List = []   # stores triggered emergency events

# ── Mode profiles — spec-accurate per EV_Q simulation document ───────────────
MODE_PROFILES: Dict = {
    "ECO": {
        # Speed 30–60, Power 15–35kW, RPM 1500–2500, BatTemp 24–28°C, Eff 6–8
        "speed_range": (30, 60),   "power_range": (15, 35),
        "rpm_range":   (1500, 2500), "bat_temp_range": (24, 28),
        "efficiency_range": (6.0, 8.0), "bat_drain_mult": 0.4,
        "range_mult": 1.45, "regen_threshold": 12,
        # Tire: stable ±0.3 PSI, baseline 33.0–33.2
        "tire_base": {"FL": 33.0, "FR": 33.2, "RL": 33.1, "RR": 33.0},
        "tire_fluctuation": 0.3, "tire_mode": "stable",
        "color": "#00ff9d", "icon": "🌿",
        "gauge_theme": "green",
        "description": "Eco mode — maximum range, minimal power draw, regen optimised.",
        "warnings": [], "emergency": False, "fault": False,
    },
    "NORMAL": {
        # Speed 40–90, Power 40–70kW, RPM 2500–4000, BatTemp 26–32°C, Eff 8–10
        "speed_range": (40, 90),   "power_range": (40, 70),
        "rpm_range":   (2500, 4000), "bat_temp_range": (26, 32),
        "efficiency_range": (8.0, 10.0), "bat_drain_mult": 1.0,
        "range_mult": 1.0, "regen_threshold": 25,
        # Tire: normal ±0.5 PSI
        "tire_base": {"FL": 32.7, "FR": 32.5, "RL": 32.8, "RR": 32.6},
        "tire_fluctuation": 0.5, "tire_mode": "normal",
        "color": "#00e5ff", "icon": "⚡",
        "gauge_theme": "cyan",
        "description": "Normal mode — balanced performance and efficiency for everyday driving.",
        "warnings": [], "emergency": False, "fault": False,
    },
    "RACE": {
        # Speed 80–180, Power 120–250kW, RPM 5000–9000, BatTemp 35–45°C, Eff 15–25
        "speed_range": (80, 180),  "power_range": (120, 250),
        "rpm_range":   (5000, 9000), "bat_temp_range": (35, 45),
        "efficiency_range": (15.0, 25.0), "bat_drain_mult": 2.2,
        "range_mult": 0.45, "regen_threshold": 55,
        # Tire: heat-expanded, fast fluctuation
        "tire_base": {"FL": 34.8, "FR": 35.1, "RL": 35.5, "RR": 35.3},
        "tire_fluctuation": 1.2, "tire_mode": "hot",
        "color": "#ff6b35", "icon": "🏎️",
        "gauge_theme": "orange",
        "description": "Race mode — maximum performance, aggressive acceleration. Battery heat elevated.",
        "warnings": ["⚠️ High battery temperature", "⚠️ Rapid power draw", "⚠️ Reduced range"],
        "emergency": False, "fault": False,
    },
    "RISK": {
        # Speed: fluctuating, Power: unstable, BatTemp: rising, Eff: decreasing
        # One tire losing pressure
        "speed_range": (30, 140),  "power_range": (20, 160),
        "rpm_range":   (1000, 7000), "bat_temp_range": (32, 48),
        "efficiency_range": (10.0, 22.0), "bat_drain_mult": 1.8,
        "range_mult": 0.6, "regen_threshold": 40,
        # Tire: RL losing pressure
        "tire_base": {"FL": 31.2, "FR": 32.4, "RL": 30.8, "RR": 32.0},
        "tire_fluctuation": 1.5, "tire_mode": "losing",
        "tire_warn": "RL",   # which tire is warning
        "color": "#ffb800", "icon": "⚠️",
        "gauge_theme": "yellow",
        "description": "Risk mode — unstable conditions. Tire pressure loss detected. Monitor all systems.",
        "warnings": ["⚠️ Tire pressure loss on RL", "⚠️ Unstable power output", "⚠️ Battery temperature rising"],
        "emergency": False, "fault": False,
    },
    "HIGH_RISK": {
        # Speed auto-limited, Power reduced, BatTemp >45°C, BatHealth declining
        # Severe pressure loss on multiple tires
        "speed_range": (0, 60),    "power_range": (5, 40),
        "rpm_range":   (0, 3000),  "bat_temp_range": (46, 65),
        "efficiency_range": (18.0, 30.0), "bat_drain_mult": 2.8,
        "range_mult": 0.25, "regen_threshold": 10,
        # Tire: severe loss FL and RL
        "tire_base": {"FL": 28.0, "FR": 31.5, "RL": 29.3, "RR": 31.0},
        "tire_fluctuation": 2.0, "tire_mode": "critical",
        "tire_warn": "FL,RL",
        "color": "#ff4040", "icon": "🔴",
        "gauge_theme": "red",
        "description": "HIGH RISK — Critical tire pressure loss. Overheating. Reduce speed immediately.",
        "warnings": [
            "🔴 CRITICAL: Tire pressure dangerously low (FL, RL)",
            "🔴 CRITICAL: Battery overheating >45°C",
            "🔴 Speed automatically limited",
            "🔴 Pull over safely immediately",
        ],
        "emergency": False, "fault": False,
    },
    "ACCIDENT": {
        # Speed: 0, Power: 0, RPM: 0, emergency lock
        # Tires: impact damage / deflation
        "speed_range": (0, 0),     "power_range": (0, 0),
        "rpm_range":   (0, 0),     "bat_temp_range": (55, 75),
        "efficiency_range": (0, 0), "bat_drain_mult": 3.5,
        "range_mult": 0.0, "regen_threshold": 0,
        # Tire: near-zero from impact
        "tire_base": {"FL": 2.0, "FR": 10.0, "RL": 0.0, "RR": 8.0},
        "tire_fluctuation": 0.5, "tire_mode": "accident",
        "color": "#ff0000", "icon": "🚨",
        "gauge_theme": "emergency",
        "description": "ACCIDENT DETECTED — Collision detected. Airbags deployed. Emergency SOS active.",
        "warnings": [
            "🚨 COLLISION DETECTED — AIRBAGS DEPLOYED",
            "🚨 EMERGENCY SOS ACTIVE",
            "🚨 CONTACTING AMBULANCE · POLICE · FAMILY",
            "🚨 TIRES DEFLATED FROM IMPACT",
            "🚨 BATTERY EMERGENCY LOCK ENGAGED",
        ],
        "emergency": True, "fault": False,
    },
    "DEFECT": {
        # Speed limited 20 km/h, power minimal, RPM capped, TPMS fault
        "speed_range": (0, 20),    "power_range": (2, 15),
        "rpm_range":   (0, 1200),  "bat_temp_range": (28, 40),
        "efficiency_range": (12.0, 20.0), "bat_drain_mult": 1.5,
        "range_mult": 0.3, "regen_threshold": 5,
        # Tire: TPMS sensor fault — some sensors read ERROR
        "tire_base": {"FL": None, "FR": 32.0, "RL": None, "RR": 32.0},
        "tire_fluctuation": 0.2, "tire_mode": "tpms_fault",
        "color": "#a78bfa", "icon": "🔧",
        "gauge_theme": "purple",
        "description": "DEFECT MODE — Fault detected. Limp-home at 20 km/h. TPMS sensor malfunction.",
        "warnings": [
            "🔧 FAULT CODE: BMS_CELL_IMBALANCE",
            "🔧 FAULT CODE: MOTOR_TEMP_HIGH",
            "🔧 TPMS SENSOR FAULT: FL, RL",
            "🔧 Limp-home mode — max 20 km/h",
            "🔧 Service required immediately",
        ],
        "emergency": False, "fault": True,
    },
}

AGENT_META = {
    "TechnicianAgent":     {"icon": "⚙️",  "color": "#00e5ff", "role": "Technical Support"},
    "ResellerAgent":       {"icon": "🚗",  "color": "#00ff9d", "role": "Sales & Resale"},
    "FinancierAgent":      {"icon": "💳",  "color": "#ffb800", "role": "Finance & EMI"},
    "PolicyAgent":         {"icon": "🛡️", "color": "#ff6b35", "role": "Policy & Legal"},
    "RecommendationAgent": {"icon": "🧠",  "color": "#a78bfa", "role": "Personalization"},
    "EVQ_Manager":         {"icon": "⚡",  "color": "#00e5ff", "role": "Orchestrator"},
}

class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    vehicle_data: Optional[Dict] = None

class VehicleUpdateRequest(BaseModel):
    vehicle_data: Dict

class ModeRequest(BaseModel):
    mode: str

class EmergencyAlertRequest(BaseModel):
    location_lat:  float = 28.6139      # default: New Delhi
    location_lng:  float = 77.2090
    location_name: str   = "Unknown Location"
    contacts: Optional[List[str]] = None


# ═══════════════════════════════════════════════════════════════════════════════
#  LIVE VEHICLE TELEMETRY GENERATOR — spec-accurate per-mode simulation
# ═══════════════════════════════════════════════════════════════════════════════
def _lerp(lo: float, hi: float, t: float) -> float:
    return lo + (hi - lo) * t

def _generate_telemetry() -> Dict:
    """
    Generates realistic telemetry values from mode spec ranges.
    Uses smooth sine/noise oscillation within each mode's defined ranges.
    Tire pressures follow per-mode scenarios from the simulation spec.
    """
    t   = datetime.now().timestamp()
    p   = MODE_PROFILES[_active_mode]

    def _wave(period: float, offset: float = 0.0) -> float:
        """Returns 0–1 value oscillating smoothly."""
        return (math.sin(t / period + offset) + 1) / 2

    # ── Speed ────────────────────────────────────────────────────────────────
    s_lo, s_hi = p["speed_range"]
    if _active_mode == "RISK":
        # Highly fluctuating — fast random-ish oscillation
        speed = round(max(s_lo, min(s_hi, _lerp(s_lo, s_hi, _wave(4.5)) + random.uniform(-18, 18))), 1)
    elif _active_mode == "ACCIDENT":
        speed = 0.0
    else:
        speed = round(max(s_lo, min(s_hi, _lerp(s_lo, s_hi, _wave(22))  + random.uniform(-4, 4))), 1)

    # ── Power ─────────────────────────────────────────────────────────────────
    pw_lo, pw_hi = p["power_range"]
    if _active_mode == "ACCIDENT":
        power_kw = 0.0
    elif _active_mode == "RISK":
        power_kw = round(max(pw_lo, min(pw_hi, _lerp(pw_lo, pw_hi, _wave(3.5)) + random.uniform(-25, 25))), 1)
    else:
        power_kw = round(max(pw_lo, min(pw_hi, _lerp(pw_lo, pw_hi, _wave(18)) + random.uniform(-5, 5))), 1)

    # ── RPM ──────────────────────────────────────────────────────────────────
    r_lo, r_hi = p["rpm_range"]
    if _active_mode == "ACCIDENT":
        motor_rpm = 0
    else:
        motor_rpm = round(max(r_lo, min(r_hi, _lerp(r_lo, r_hi, speed / max(s_hi, 1)) + random.uniform(-100, 100))))

    # ── Battery ──────────────────────────────────────────────────────────────
    bat_lvl    = round(max(8.0, min(97.0, 72 - (t % 3600) / 200 * p["bat_drain_mult"] + 3 * math.sin(t/90) + random.uniform(-0.6, 0.6))), 1)
    bat_health = round(max(70.0, min(99.0, 93 + 2 * math.sin(t/900) + random.uniform(-0.2, 0.2)
                           - (5 if _active_mode in ("ACCIDENT","HIGH_RISK") else 0))), 1)

    # ── Battery Temperature — per-mode range ─────────────────────────────────
    bt_lo, bt_hi = p["bat_temp_range"]
    bat_temp = round(max(bt_lo, min(bt_hi + 5,
                         _lerp(bt_lo, bt_hi, _wave(45)) + random.uniform(-1.5, 1.5))), 1)

    # ── Efficiency ───────────────────────────────────────────────────────────
    e_lo, e_hi = p["efficiency_range"]
    if _active_mode == "ACCIDENT":
        efficiency = 0.0
    else:
        efficiency = round(max(e_lo, min(e_hi, _lerp(e_lo, e_hi, _wave(80)) + random.uniform(-0.3, 0.3))), 2)

    # ── Range ────────────────────────────────────────────────────────────────
    range_km = round(bat_lvl * 3.85 * p["range_mult"] + random.uniform(-3, 3)) if p["range_mult"] > 0 else 0

    # ── Cabin / Odo ───────────────────────────────────────────────────────────
    cabin_temp = round(22 + random.uniform(-1.2, 1.2) + (3 if _active_mode in ("RACE","HIGH_RISK") else 0), 1)
    odometer   = round(12543 + (t % 9000) * 0.001)
    regen      = speed > p["regen_threshold"] and random.random() > 0.55

    # ── Tire pressures — per-mode spec ───────────────────────────────────────
    tbase = p["tire_base"]
    tfluc = p["tire_fluctuation"]
    tmode = p["tire_mode"]

    def _tire(pos: str) -> float | str:
        base = tbase.get(pos)
        if base is None:
            # TPMS fault — alternate between ERROR string and occasional reading
            return "ERR" if random.random() > 0.25 else round(30 + random.uniform(-1, 1), 1)
        if base == 0.0:
            return round(max(0, base + random.uniform(0, 0.8)), 1)  # near zero
        if tmode == "losing":
            # RL slowly losing — drop by time
            warn_pos = p.get("tire_warn", "")
            if pos in warn_pos:
                drop = min(4.0, (t % 300) / 300 * 3.0)   # gradually loses up to 3 PSI over 5 min
                return round(max(10.0, base - drop + random.uniform(-tfluc/2, tfluc/2)), 1)
        if tmode == "critical":
            warn_pos = p.get("tire_warn", "")
            if pos in warn_pos:
                return round(max(22.0, base + random.uniform(-tfluc, tfluc/2)), 1)
        if tmode == "hot":
            # Temperature expansion
            temp_factor = (bat_temp - 25) * 0.02
            return round(base + temp_factor + random.uniform(-tfluc/2, tfluc/2), 1)
        return round(base + random.uniform(-tfluc/2, tfluc/2), 1)

    tires = {k: _tire(k) for k in ("FL", "FR", "RL", "RR")}

    # ── AI Safety auto-escalation ─────────────────────────────────────────────
    tire_numeric = [v for v in tires.values() if isinstance(v, (int, float))]
    min_psi = min(tire_numeric) if tire_numeric else 32
    puncture_alert = min_psi < 30 and speed > 90

    # ── Status labels ─────────────────────────────────────────────────────────
    bat_status    = ("CRITICAL ⚠️" if bat_lvl<20  else "LOW"       if bat_lvl<35  else "GOOD"        if bat_lvl<75  else "HIGH ✅")
    health_status = ("EXCELLENT ✅" if bat_health>=95 else "GOOD ✅" if bat_health>=88 else "FAIR ⚠️" if bat_health>=80 else "POOR ❌")
    temp_status   = ("OVERHEATING 🔥" if bat_temp>62 else "CRITICAL ⚠️" if bat_temp>50 else "WARM" if bat_temp>40 else "OPTIMAL ✅" if bat_temp>22 else "COLD")
    range_status  = ("CRITICAL ⚠️" if range_km<20 else "LOW" if range_km<50 else "OK" if range_km<120 else "GOOD ✅")
    speed_label   = ("STOPPED" if speed<2 else "SLOW" if speed<40 else "CITY" if speed<80 else "HIGHWAY" if speed<130 else "EXTREME ⚠️")

    return {
        # Core dashboard fields
        "speed": speed, "battery_level": bat_lvl, "battery_health": bat_health,
        "battery_temp": bat_temp, "motor_rpm": motor_rpm, "range_km": range_km,
        "power_kw": power_kw, "regen_active": regen, "charging": bat_lvl < 18,
        "cabin_temp": cabin_temp, "odometer": odometer, "efficiency": efficiency,
        "drive_mode": _active_mode, "tire_pressures": tires,
        # Visual theme for frontend
        "gauge_theme": p.get("gauge_theme", "cyan"),
        "mode_color":  p.get("color", "#00e5ff"),
        "mode_icon":   p.get("icon", "⚡"),
        # Agent context
        "battery_status": bat_status, "battery_health_status": health_status,
        "battery_temp_status": temp_status, "range_status": range_status,
        "speed_label": speed_label, "regen_braking_active": regen,
        "puncture_alert": puncture_alert, "tire_mode": tmode,
        "tire_warn_positions": p.get("tire_warn", ""),
        "mode_description": p.get("description", ""),
        "mode_warnings":    p.get("warnings", []),
        "is_emergency":     p.get("emergency", False),
        "is_fault":         p.get("fault", False),
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  VEHICLE TOOL — ADK-compatible plain function
#  Agents call this to get real-time vehicle data
# ═══════════════════════════════════════════════════════════════════════════════
def get_vehicle_status() -> str:
    """
    Returns the current real-time status of the connected EV (Electric Vehicle).
    Call this tool whenever the user asks about their vehicle's battery,
    speed, range, motor, temperature, tyres, charging state, drive mode,
    or any other live vehicle metric.
    Returns a JSON string with all telemetry fields.
    """
    # Use the latest pushed snapshot if available, else generate fresh
    data = _vehicle_state if _vehicle_state else _generate_telemetry()
    return json.dumps(data, indent=2)


# ═══════════════════════════════════════════════════════════════════════════════
#  AGENT INIT
# ═══════════════════════════════════════════════════════════════════════════════
def _init_agents() -> None:
    global _runner, _agent_ok, _init_error
    if not GOOGLE_API_KEY:
        _init_error = "GOOGLE_API_KEY is empty. Check api.py."
        print(f"❌  {_init_error}")
        return
    try:
        os.environ["GOOGLE_API_KEY"] = GOOGLE_API_KEY

        from google.adk.agents  import Agent
        from google.adk.runners import InMemoryRunner
        from google.adk.tools   import AgentTool, google_search
        from google.adk.models.google_llm import Gemini
        print("✅  google-adk imports OK")
        # NOTE: Gemini API forbids mixing built-in tools (google_search) with
        # function-call tools (get_vehicle_status) on the SAME agent.
        # Fix: specialist agents use ONLY get_vehicle_status (function tool).
        #      A dedicated SearchAgent uses ONLY google_search (built-in tool).

        retry = None
        try:
            from google.genai import types as _gt
            retry = _gt.HttpRetryOptions(
                attempts=3, exp_base=4, initial_delay=1,
                http_status_codes=[429, 500, 503, 504],
            )
        except Exception as re_err:
            print(f"⚠️   HttpRetryOptions skipped ({re_err})")

        MODEL = "gemini-2.5-flash-lite"

        def _m():
            return Gemini(model=MODEL, retry_options=retry) if retry else Gemini(model=MODEL)

        # ── Technician — has get_vehicle_status + google_search ───────────────
        technician = Agent(
            name="TechnicianAgent", model=_m(),
            instruction=(
                "You are a certified EV on-board diagnostics specialist integrated directly into the vehicle.\n"
                "ALWAYS call get_vehicle_status() first for ANY question about the vehicle condition, "
                "battery, charging, temperature, range, speed, motor, tyres, or drive mode.\n"
                "Then analyse the REAL numbers from the tool and give a specific, data-driven response.\n"
                "Format your response with the actual values prominently (e.g. 'Battery: 74.3% — GOOD').\n"
                "Never give generic advice when real vehicle data is available.\n"
                "Use your built-in EV knowledge to provide detailed technical guidance."
            ),
            tools=[get_vehicle_status],
            output_key="tech_support_response",
        )

        # ── Reseller — has get_vehicle_status so it can reference current range/health ──
        reseller = Agent(
            name="ResellerAgent", model=_m(),
            instruction=(
                "You are an EV dealership & resale expert.\n"
                "When the user asks about resale value, trade-in, or model comparisons, "
                "call get_vehicle_status() to check the current vehicle's battery health and odometer "
                "before estimating resale value — these directly affect the price.\n"
                "Compare models and retrieve prices. Use markdown tables when comparing.\n"
                "Use your built-in market knowledge to compare prices and models."
            ),
            tools=[get_vehicle_status],
            output_key="reseller_recommendation",
        )

        # ── Financier ─────────────────────────────────────────────────────────
        financier = Agent(
            name="FinancierAgent", model=_m(),
            instruction=(
                "You are an EV finance specialist.\n"
                "Calculate EMI, total cost of ownership, subsidies & government incentives.\n"
                "If the user asks about running costs or charging costs, call get_vehicle_status() "
                "to get the vehicle's current efficiency and battery capacity for accurate calculations.\n"
                "Show clear numerical breakdowns."
            ),
            tools=[get_vehicle_status],
            output_key="finance_calculation",
        )

        # ── Policy ────────────────────────────────────────────────────────────
        policy = Agent(
            name="PolicyAgent", model=_m(),
            instruction=(
                "You are an EV legal & compliance advisor.\n"
                "Explain insurance requirements, battery warranties, safety regulations, and incentives.\n"
                "Call get_vehicle_status() when battery health or odometer is relevant to warranty claims."
            ),
            tools=[get_vehicle_status],
            output_key="policy_guidance",
        )

        # ── Recommender ───────────────────────────────────────────────────────
        recommender = Agent(
            name="RecommendationAgent", model=_m(),
            instruction=(
                "You are an EV personalisation advisor.\n"
                "Call get_vehicle_status() to understand the user's current vehicle performance "
                "(range, efficiency, battery health) before recommending upgrades or alternative EVs.\n"
                "Rank recommendations by suitability to the user's real driving data."
            ),
            tools=[get_vehicle_status],
            output_key="personalized_recommendation",
        )

        # ── Manager / Orchestrator ────────────────────────────────────────────
        manager = Agent(
            name="EVQ_Manager", model=_m(),
            instruction=(
                "You are EV_Q — an AI system embedded directly inside a real Electric Vehicle.\n"
                "You have live sensor access via your specialist agents.\n\n"
                "ROUTING RULES:\n"
                "1. Battery, range, speed, temperature, tyres, motor, drive mode, any vehicle condition → TechnicianAgent\n"
                "2. Buying/selling/comparison/pricing/resale → ResellerAgent\n"
                "3. EMI/loan/subsidy/running cost → FinancierAgent\n"
                "4. Insurance/warranty/policy/regulation → PolicyAgent\n"
                "5. Personalised EV recommendation → RecommendationAgent\n\n"
                "CRITICAL OUTPUT RULES:\n"
                "- After receiving a specialist agent's response, you MUST write your own final answer.\n"
                "- NEVER return an empty response. ALWAYS write at least 2-3 sentences summarising the agent's findings.\n"
                "- Include the actual numbers from the vehicle data (e.g. Battery: 74% — GOOD).\n"
                "- Format with clear sections. Speak as the vehicle's intelligent dashboard assistant.\n"
                "- If the agent returned vehicle sensor data, present it clearly with status labels."
            ),
            tools=[
                AgentTool(technician), AgentTool(reseller),
                AgentTool(financier),  AgentTool(policy), AgentTool(recommender),
            ],
        )

        _runner = InMemoryRunner(agent=manager)
        _agent_ok   = True
        _init_error = ""
        print("✅  All agents ready! app_name:", _runner.app_name)

    except Exception:
        _agent_ok   = False
        _init_error = traceback.format_exc()
        print("❌  Agent init FAILED:\n" + _init_error)


@app.on_event("startup")
async def _startup():
    await asyncio.get_event_loop().run_in_executor(None, _init_agents)
    await broker.start()


# ═══════════════════════════════════════════════════════════════════════════════
#  SESSION HELPER
# ═══════════════════════════════════════════════════════════════════════════════
async def _ensure_session(session_id: str) -> str:
    svc      = _runner.session_service
    app_name = _runner.app_name
    existing = await svc.get_session(app_name=app_name, user_id=_USER_ID, session_id=session_id)
    if existing is not None:
        return session_id
    session = await svc.create_session(app_name=app_name, user_id=_USER_ID, session_id=session_id)
    return session.id


# ═══════════════════════════════════════════════════════════════════════════════
#  ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════
@app.get("/")
def root():
    return {"status": "online" if _agent_ok else "error", "agents": _agent_ok,
            "version": "2.0.0", "error": _init_error if not _agent_ok else None}

@app.get("/api/debug")
def debug_info():
    return {"agent_ok": _agent_ok, "init_error": _init_error,
            "api_key_len": len(GOOGLE_API_KEY),
            "api_key_prefix": (GOOGLE_API_KEY[:8]+"...") if GOOGLE_API_KEY else "EMPTY",
            "python": sys.version,
            "runner_methods": ([a for a in dir(_runner) if not a.startswith("_")] if _runner else [])}

@app.post("/api/reinit")
async def reinit():
    global _agent_ok, _runner, _init_error
    _agent_ok = False; _runner = None
    await asyncio.get_event_loop().run_in_executor(None, _init_agents)
    return {"ok": _agent_ok, "error": _init_error or None}


# ── Chat — uses message broker so concurrent requests queue, not pile up ─────
@app.post("/api/chat")
async def chat(req: ChatRequest):
    global _vehicle_state

    if not _agent_ok or _runner is None:
        raise HTTPException(503, detail={
            "message": "Agents not ready — check /api/debug", "error": _init_error})

    if req.vehicle_data:
        _vehicle_state = req.vehicle_data

    session_id = req.session_id or str(uuid.uuid4())
    job_id     = str(uuid.uuid4())

    # Build the coroutine but don't run it yet — hand it to the broker
    coro = _run_chat(req.message, session_id)

    await broker.enqueue(job_id, coro)

    try:
        result = await broker.get_result(job_id, timeout=120.0)
        return result
    except asyncio.TimeoutError:
        raise HTTPException(504, detail="Request timed out in queue — try again")
    except Exception:
        tb = traceback.format_exc()
        print("❌  Chat error:\n" + tb)
        raise HTTPException(500, detail=tb.splitlines()[-1])


async def _run_chat(message: str, session_id: str) -> dict:
    """Core chat logic — called by the broker worker."""
    global _query_count
    _query_count += 1

    from google.genai import types as _gt

    session_id  = await _ensure_session(session_id)
    new_message = _gt.Content(role="user", parts=[_gt.Part(text=message)])

    events: list = []
    async for event in _runner.run_async(
        user_id=_USER_ID,
        session_id=session_id,
        new_message=new_message,
    ):
        events.append(event)

    text, agents_used = _extract(events)

    _session_history.append({"role": "user",      "content": message,
                              "session": session_id, "ts": _ts()})
    _session_history.append({"role": "assistant",  "content": text,
                              "agents": agents_used, "ts": _ts()})

    return {"response": text, "agents_used": agents_used,
            "query_index": _query_count, "session_id": session_id, "ts": _ts()}


def _extract(events: list):
    """
    Extract final response text + agent names from ADK event stream.

    Event anatomy (ADK 1.x with AgentTool):
      manager  → function_call  (calls TechnicianAgent)
      technician → function_call (calls get_vehicle_status)
      technician → function_response (tool result JSON)
      technician → text  ← sub-agent's answer lives HERE
      manager  → function_response (wraps sub-agent output)
      manager  → text  ← manager synthesis (sometimes empty)

    Strategy: collect every non-empty text from every event, every author.
    Return the longest text found — that's almost always the sub-agent's
    detailed answer. If manager synthesizes something longer, that wins.
    """
    all_texts:   list = []   # (author, text) tuples
    agents_used: list = []

    for ev in events:
        author  = getattr(ev, "author", None) or ""
        content = getattr(ev, "content", None)

        # Track which specialist agents fired
        if author and author not in ("EVQ_Manager", "user", ""):
            if author not in agents_used:
                agents_used.append(author)
                _agent_hits[author] = _agent_hits.get(author, 0) + 1

        if not content:
            continue

        for part in (getattr(content, "parts", None) or []):

            # ── function_call: track agent name ───────────────────────────
            fc = getattr(part, "function_call", None)
            if fc:
                name = getattr(fc, "name", None)
                if name and name not in agents_used and name not in ("get_vehicle_status",):
                    agents_used.append(name)
                    _agent_hits[name] = _agent_hits.get(name, 0) + 1

            # ── function_response: sub-agent output is buried here ─────────
            fr = getattr(part, "function_response", None)
            if fr:
                resp = getattr(fr, "response", None) or {}
                # output_key stores sub-agent text in resp["output"] or resp["result"]
                for key in ("output", "result", "content", "text"):
                    val = resp.get(key, "") if isinstance(resp, dict) else ""
                    if val and isinstance(val, str) and val.strip():
                        all_texts.append((author or "tool", val.strip()))

            # ── direct text part ───────────────────────────────────────────
            t = getattr(part, "text", None)
            if t and t.strip():
                all_texts.append((author or "unknown", t.strip()))

    # Pick best text: prefer manager's final answer if substantial,
    # otherwise use the longest text from any agent (sub-agent's detailed answer)
    manager_texts = [txt for auth, txt in all_texts if auth in ("EVQ_Manager", "")]
    agent_texts   = [txt for auth, txt in all_texts if auth not in ("EVQ_Manager", "", "user")]

    # Debug print (remove after confirming)
    print(f"  📊 _extract: {len(events)} events, {len(all_texts)} texts found")
    print(f"     manager texts: {len(manager_texts)}, agent texts: {len(agent_texts)}")
    for auth, txt in all_texts:
        print(f"     [{auth}] {txt[:80]}...")

    # Decision: take the last manager text if it is non-trivial (>50 chars)
    # otherwise fall back to the longest agent text
    best = ""
    if manager_texts:
        last_mgr = manager_texts[-1]
        if len(last_mgr) > 50:
            best = last_mgr
    if not best and agent_texts:
        best = max(agent_texts, key=len)
    if not best and all_texts:
        best = max(all_texts, key=lambda x: len(x[1]))[1]

    return (best or "I processed your request but got an empty response — please try again."), agents_used

def _ts() -> str:
    return datetime.now().isoformat()


# ── Vehicle telemetry (HTTP endpoint for the dashboard) ──────────────────────
@app.get("/api/vehicle/status")
def vehicle_status():
    global _vehicle_state
    data = _generate_telemetry()
    _vehicle_state = data          # always keep the freshest snapshot for agents
    return data

# Frontend can push its latest local telemetry snapshot here
@app.post("/api/vehicle/update")
def vehicle_update(req: VehicleUpdateRequest):
    global _vehicle_state
    _vehicle_state = req.vehicle_data
    return {"ok": True}


# ── Drive mode toggle ─────────────────────────────────────────────────────────
@app.get("/api/mode")
def get_mode():
    """Returns the currently active drive mode and its profile."""
    return {
        "mode":        _active_mode,
        "profile":     MODE_PROFILES[_active_mode],
        "all_modes":   list(MODE_PROFILES.keys()),
    }

@app.post("/api/mode")
def set_mode(req: ModeRequest):
    """Switch drive mode. Immediately affects all future telemetry."""
    global _active_mode, _vehicle_state
    mode = req.mode.upper()
    if mode not in MODE_PROFILES:
        raise HTTPException(400, f"Unknown mode '{mode}'. Valid: {list(MODE_PROFILES.keys())}")
    _active_mode = mode
    # Invalidate cached state so next poll generates fresh mode-aware data
    _vehicle_state = {}
    print(f"🔄  Drive mode → {_active_mode}")
    return {
        "ok":      True,
        "mode":    _active_mode,
        "profile": MODE_PROFILES[_active_mode],
    }

# ── Emergency alert endpoint ─────────────────────────────────────────────────
@app.post("/api/emergency/alert")
async def emergency_alert(req: EmergencyAlertRequest):
    """Triggered automatically when ACCIDENT mode is set."""
    global _emergency_log
    ts    = datetime.now().isoformat()
    event = {
        "ts":           ts,
        "mode":         _active_mode,
        "location_lat": req.location_lat,
        "location_lng": req.location_lng,
        "location_name":req.location_name,
        "contacts":     req.contacts or ["Ambulance: 108", "Police: 100", "Family Member"],
        "vehicle_data": _vehicle_state,
        "maps_url":     f"https://maps.google.com/?q={req.location_lat},{req.location_lng}",
        "message": (
            f"\U0001f6a8 EMERGENCY ALERT - EV_Q VEHICLE\n"
            f"Collision detected at {req.location_name}\n"
            f"Location: {req.location_lat:.4f}, {req.location_lng:.4f}\n"
            f"Maps: https://maps.google.com/?q={req.location_lat},{req.location_lng}\n"
            f"Battery: {_vehicle_state.get('battery_level', '?')}% | "
            f"Temp: {_vehicle_state.get('battery_temp', '?')}C\n"
            f"Time: {ts}\n"
            "PLEASE SEND IMMEDIATE ASSISTANCE."
        ),
    }
    _emergency_log.append(event)
    print(f"🚨 EMERGENCY ALERT fired: {event['location_name']} @ {ts}")
    return {"ok": True, "event": event, "contacts_notified": event["contacts"]}

@app.get("/api/emergency/log")
def emergency_log():
    return {"events": _emergency_log[-20:], "total": len(_emergency_log)}

@app.get("/api/stats")
def stats():
    return {"total_queries": _query_count, "agents_active": 5,
            "model": "Gemini 2.5 Flash Lite", "version": "2.0.0",
            "agent_hits": _agent_hits,
            "status": "online" if _agent_ok else "error",
            "messages": len(_session_history)}

@app.get("/api/agents")
def agents_list():
    return {"agents": [{"id": k, **v, "queries": _agent_hits.get(k, 0)}
                       for k, v in AGENT_META.items() if k != "EVQ_Manager"]}