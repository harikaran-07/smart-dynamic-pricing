import pandas as pd
import numpy as np
import sys
sys.path.insert(0, '.')
from src.data import preprocess

n = 1000
np.random.seed(42)
df = pd.DataFrame()
df['branch'] = ['A'] * n
df['city'] = ['NYC'] * n
df['customer_type'] = ['Member'] * n
df['gender'] = ['M'] * 500 + ['F'] * 500
df['product line'] = ['Electronics'] * n
df['unit price'] = np.random.uniform(10, 500, n)
df['quantity'] = np.random.poisson(50, n)
df['tax 5%'] = np.nan
df['sales'] = None
df['cogs'] = None
df['gross income'] = None
df['date'] = pd.date_range('2024-01-01', periods=n, freq='D')
df['time'] = np.random.randint(9, 21, n)
df['payment'] = ['Cash'] * 600 + ['Card'] * 400
df['Rating'] = np.random.uniform(1, 5, n)

df['sales'] = df['unit price'] * df['quantity'] * 1.05
df['tax 5%'] = df['sales'] * 0.05
df['cogs'] = df['unit price'] * 0.6
df['gross income'] = df['sales'] - df['cogs']

leakage = preprocess._detect_leakage_columns(df, target='sales')
print(leakage['warning'])
print()
print('Leaked columns:', leakage['leaked'])
print('Safe columns:', leakage['safe'])