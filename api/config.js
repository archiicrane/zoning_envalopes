// Vercel Serverless Function to expose Mapbox token
export default function handler(req, res) {
  res.status(200).json({ mapboxToken: process.env.MAPBOX_TOKEN });
}
