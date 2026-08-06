from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data" / "raw"
PROCESSED_DIR = BASE_DIR / "data" / "processed"
MODEL_DIR = BASE_DIR / "models"
DASHBOARD_DIR = BASE_DIR / "dashboard"
REPORTS_DIR = BASE_DIR / "reports"

DATA_DIR.mkdir(parents=True, exist_ok=True)
PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
MODEL_DIR.mkdir(parents=True, exist_ok=True)
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

SALES_CSV = DATA_DIR / "sales.csv"
CUSTOMERS_CSV = DATA_DIR / "customers.csv"
WEATHER_CSV = DATA_DIR / "weather.csv"

SALES_PROCESSED = PROCESSED_DIR / "sales_features.csv"
CUSTOMERS_PROCESSED = PROCESSED_DIR / "customers_featured.csv"
PRICE_ARTIFACT = MODEL_DIR / "price_predictor.joblib"
DEMAND_ARTIFACT = MODEL_DIR / "demand_models.joblib"
SEG_ARTIFACT = MODEL_DIR / "customers_model.joblib"
ARIMA_ARTIFACT = MODEL_DIR / "arima_results.pkl"
TE_ARTIFACT = MODEL_DIR / "labels.joblib"
REPORT_JSON = REPORTS_DIR / "report.json"

N_PRODUCTS = 20
N_DAYS_HISTORY = 730
SEED = 42