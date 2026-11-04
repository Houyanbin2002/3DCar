import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { VehicleShowroom } from '../../src/ui/VehicleShowroom';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<StrictMode><VehicleShowroom /></StrictMode>);
