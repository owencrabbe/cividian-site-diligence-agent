// data/cities.js
// Single source of truth for the city list.
// Fixes "replace the hardcoded city arrays": both index.html and app.html
// fetch this from /api/cities instead of carrying duplicate inline arrays.
// Each entry carries the FIPS place identifiers as reference data. Runtime
// Census lookups resolve places by name against the live ACS place list
// (lib/citydata.js) and take placeFips from the API response, so these columns
// are documentation, not a lookup path. Anderson IN, Muncie, Kokomo, and
// New Castle codes were corrected against Census place geoids in August 2026;
// verify any code here before wiring it into a query.

export const CITIES = [
  // name, state, stateFips, placeFips, lat, lng
  ["Muncie", "Indiana", "18", "51876", 40.1934, -85.3864],
  ["Anderson", "Indiana", "18", "01468", 40.1053, -85.6803],
  ["Fort Wayne", "Indiana", "18", "25000", 41.0793, -85.1394],
  ["Indianapolis", "Indiana", "18", "36003", 39.7684, -86.1581],
  ["Kokomo", "Indiana", "18", "40392", 40.4864, -86.1336],
  ["Bloomington", "Indiana", "18", "05860", 39.1653, -86.5264],
  ["Richmond", "Indiana", "18", "64260", 39.8289, -84.8902],
  ["Marion", "Indiana", "18", "46908", 40.5584, -85.659],
  ["New Castle", "Indiana", "18", "52740", 39.9295, -85.3702],
  ["Columbus", "Indiana", "18", "14734", 39.2014, -85.9214],
  ["Lafayette", "Indiana", "18", "40788", 40.4167, -86.8753],
  ["Terre Haute", "Indiana", "18", "75428", 39.4667, -87.4139],
  ["Evansville", "Indiana", "18", "22000", 37.9716, -87.5711],
  ["South Bend", "Indiana", "18", "71000", 41.6764, -86.252],
  ["Gary", "Indiana", "18", "27000", 41.5934, -87.3464],
  ["Carmel", "Indiana", "18", "10342", 39.9784, -86.118],
  ["Fishers", "Indiana", "18", "23278", 39.9568, -85.9685],
  ["Elkhart", "Indiana", "18", "20502", 41.6819, -85.9767],
  ["Anderson", "South Carolina", "45", "01345", 34.5034, -82.6501],
  ["Anderson", "California", "06", "01640", 40.4488, -122.2978],
  ["Columbus", "Ohio", "39", "18000", 39.9612, -82.9988],
  ["Columbus", "Georgia", "13", "19000", 32.461, -84.9877],
  ["Springfield", "Illinois", "17", "72000", 39.7817, -89.6501],
  ["Springfield", "Missouri", "29", "70000", 37.209, -93.2923],
  ["Springfield", "Massachusetts", "25", "67000", 42.1015, -72.5898],
  ["Springfield", "Ohio", "39", "74000", 39.9242, -83.8088],
  ["Richmond", "Virginia", "51", "67000", 37.5407, -77.436],
  ["Richmond", "California", "06", "60620", 37.9358, -122.3477],
  ["Richmond", "Kentucky", "21", "65226", 37.7479, -84.2947],
  ["Portland", "Oregon", "41", "59000", 45.5152, -122.6784],
  ["Portland", "Maine", "23", "60545", 43.6591, -70.2568],
  ["New York", "New York", "36", "51000", 40.7128, -74.006],
  ["Los Angeles", "California", "06", "44000", 34.0522, -118.2437],
  ["Chicago", "Illinois", "17", "14000", 41.8781, -87.6298],
  ["Houston", "Texas", "48", "35000", 29.7604, -95.3698],
  ["Phoenix", "Arizona", "04", "55000", 33.4484, -112.074],
  ["Philadelphia", "Pennsylvania", "42", "60000", 39.9526, -75.1652],
  ["San Antonio", "Texas", "48", "65000", 29.4241, -98.4936],
  ["San Diego", "California", "06", "66000", 32.7157, -117.1611],
  ["Dallas", "Texas", "48", "19000", 32.7767, -96.797],
  ["San Jose", "California", "06", "68000", 37.3382, -121.8863],
  ["Austin", "Texas", "48", "05000", 30.2672, -97.7431],
  ["Jacksonville", "Florida", "12", "35000", 30.3322, -81.6557],
  ["Charlotte", "North Carolina", "37", "12000", 35.2271, -80.8431],
  ["San Francisco", "California", "06", "67000", 37.7749, -122.4194],
  ["Seattle", "Washington", "53", "63000", 47.6062, -122.3321],
  ["Denver", "Colorado", "08", "20000", 39.7392, -104.9903],
  ["Nashville", "Tennessee", "47", "52006", 36.1627, -86.7816],
  ["Oklahoma City", "Oklahoma", "40", "55000", 35.4676, -97.5164],
  ["Washington", "District of Columbia", "11", "50000", 38.9072, -77.0369],
  ["Boston", "Massachusetts", "25", "07000", 42.3601, -71.0589],
  ["Las Vegas", "Nevada", "32", "40000", 36.1699, -115.1398],
  ["Detroit", "Michigan", "26", "22000", 42.3314, -83.0458],
  ["Louisville", "Kentucky", "21", "48006", 38.2527, -85.7585],
  ["Memphis", "Tennessee", "47", "48000", 35.1495, -90.049],
  ["Baltimore", "Maryland", "24", "04000", 39.2904, -76.6122],
  ["Milwaukee", "Wisconsin", "55", "53000", 43.0389, -87.9065],
  ["Albuquerque", "New Mexico", "35", "02000", 35.0844, -106.6504],
  ["Tucson", "Arizona", "04", "77000", 32.2226, -110.9747],
  ["Sacramento", "California", "06", "64000", 38.5816, -121.4944],
  ["Kansas City", "Missouri", "29", "38000", 39.0997, -94.5786],
  ["Atlanta", "Georgia", "13", "04000", 33.749, -84.388],
  ["Omaha", "Nebraska", "31", "37000", 41.2565, -95.9345],
  ["Raleigh", "North Carolina", "37", "55000", 35.7796, -78.6382],
  ["Miami", "Florida", "12", "45000", 25.7617, -80.1918],
  ["Minneapolis", "Minnesota", "27", "43000", 44.9778, -93.265],
  ["New Orleans", "Louisiana", "22", "55000", 29.9511, -90.0715],
  ["Cleveland", "Ohio", "39", "16000", 41.4993, -81.6944],
  ["Pittsburgh", "Pennsylvania", "42", "61000", 40.4406, -79.9959],
  ["St. Louis", "Missouri", "29", "65000", 38.627, -90.1994],
  ["Cincinnati", "Ohio", "39", "15000", 39.1031, -84.512],
  ["Orlando", "Florida", "12", "53000", 28.5383, -81.3792],
  ["Tampa", "Florida", "12", "71000", 27.9506, -82.4572],
  ["Dayton", "Ohio", "39", "21000", 39.7589, -84.1916],
  ["Flint", "Michigan", "26", "29000", 43.0125, -83.6875],
  ["Toledo", "Ohio", "39", "77000", 41.6528, -83.5379],
  ["Akron", "Ohio", "39", "01000", 41.0814, -81.519],
  ["Grand Rapids", "Michigan", "26", "34000", 42.9634, -85.6681],
  ["Ann Arbor", "Michigan", "26", "03000", 42.2808, -83.743],
  ["Lansing", "Michigan", "26", "46000", 42.7325, -84.5555],
  ["Madison", "Wisconsin", "55", "48000", 43.0731, -89.4012],
  ["Des Moines", "Iowa", "19", "21000", 41.5868, -93.625],
  ["Boise", "Idaho", "16", "08830", 43.615, -116.2023],
  ["Birmingham", "Alabama", "01", "07000", 33.5186, -86.8104],
  ["Knoxville", "Tennessee", "47", "40000", 35.9606, -83.9207],
  ["Chattanooga", "Tennessee", "47", "14000", 35.0456, -85.3097],
  ["Buffalo", "New York", "36", "11000", 42.8864, -78.8784],
  ["Rochester", "New York", "36", "63000", 43.1566, -77.6088],
];

export function findCity(name, state) {
  const n = String(name || "").toLowerCase();
  const s = String(state || "").toLowerCase();
  return (
    CITIES.find(
      (c) => c[0].toLowerCase() === n && c[1].toLowerCase() === s
    ) || CITIES.find((c) => c[0].toLowerCase() === n) || null
  );
}
