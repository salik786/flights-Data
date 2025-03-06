const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware for security and performance
app.use(cors());
app.use(helmet());
app.use(express.json());

// Rate limiting to prevent abuse
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

// Utility function to format the date as `YYYY-MM-DD`
const formatDate = (date) => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${year}-${month}-${day}`;
};

// Function to validate input parameters
const validateParams = (date, flightType, flightDirection) => {
    const validFlightTypes = ['domestic', 'international'];
    const validDates = ['today', 'yesterday', 'tomorrow', 'day_after_tomorrow'];
    const validDirections = ['arrival', 'departure'];

    if (flightType && !validFlightTypes.includes(flightType)) {
        return { isValid: false, message: 'Invalid flight type. Use "domestic" or "international".' };
    }

    if (date && !validDates.includes(date)) {
        return { isValid: false, message: 'Invalid date. Use "today", "yesterday", "tomorrow", or "day_after_tomorrow".' };
    }

    if (flightDirection && !validDirections.includes(flightDirection)) {
        return { isValid: false, message: 'Invalid flight direction. Use "arrival" or "departure".' };
    }

    return { isValid: true };
};

// Function to get flight data from Sydney Airport API
const getFlightData = async (date, flightType, flightDirection) => {
    const formattedDate = formatDate(date);
    console.log(`Fetching ${flightType} ${flightDirection}s for ${formattedDate}`);

    // Build the API URL - based on the format you provided
    const apiUrl = `https://www.sydneyairport.com.au/_a/flights?filter=&date=${formattedDate}&count=1000&startFrom=0&seq=1&sortColumn=scheduled_time&ascending=true&showAll=true&terminalType=${flightType}&flightType=${flightDirection}`;

    try {
        // Make the API request with necessary headers
        const response = await axios.get(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/json',
                'Referer': 'https://www.sydneyairport.com.au/flights/',
                'Origin': 'https://www.sydneyairport.com.au'
            },
            timeout: 30000 // 30 second timeout
        });

        // Extract the data - based on the sample response you provided
        // The data appears to be directly in the response rather than in a 'results' property
        const data = response.data;

        if (!data || !data.flightData || !Array.isArray(data.flightData)) {
            console.error('Unexpected API response format:', data);
            throw new Error('Unexpected API response format');
        }

        console.log(`Total flights found: ${data.totalFlightCount}`);

        // Process and transform the flight data
        const processedData = data.flightData.map(flight => {
            // Determine flight status based on the status field and statusColor
            let status = 'on time';

            if (flight.status) {
                const statusLower = flight.status.toLowerCase();
                if (statusLower.includes('cancel')) {
                    status = 'cancelled';
                } else if (statusLower.includes('delay') ||
                    (flight.estimatedTime && flight.estimatedTime !== flight.scheduledTime && flight.estimatedTime !== '-')) {
                    status = 'delayed';
                }
            }

            // Determine if this is a Qantas flight (terminal 3)
            const isT3 = flight.airline && flight.airline.toLowerCase().includes('qantas');

            // Join destinations array into a string
            const location = Array.isArray(flight.destinations)
                ? flight.destinations.join(', ')
                : (Array.isArray(flight.origins) ? flight.origins.join(', ') : '');

            // Join flight numbers array into a string
            const flightNumber = Array.isArray(flight.flightNumbers)
                ? flight.flightNumbers.join(', ')
                : '';

            return {
                id: flight.id,
                scheduledTime: flight.scheduledTime || '',
                estimatedTime: flight.estimatedTime || '',
                status,
                statusColor: flight.statusColor || '',
                airline: flight.airline || '',
                airlineCode: flight.airlineCode || '',
                flightNumber,
                location,
                terminal: isT3 ? 'T3' : 'T2',
                rawStatus: flight.status || 'Unknown'
            };
        });

        // Log status distribution for debugging
        const statusCount = processedData.reduce((acc, flight) => {
            acc[flight.status] = (acc[flight.status] || 0) + 1;
            return acc;
        }, {});
        console.log('Status distribution:', statusCount);

        return {
            totalFlights: data.totalFlightCount,
            flights: processedData
        };
    } catch (error) {
        console.error('Error fetching flight data:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
        }
        throw error;
    }
};

// Endpoint to get flight data based on selected filters
app.get('/api/flights', async (req, res) => {
    try {
        const {
            date = 'today',
            flightType = 'domestic',
            flightDirection = 'departure'
        } = req.query;

        // Validate parameters
        const validation = validateParams(date, flightType, flightDirection);
        if (!validation.isValid) {
            return res.status(400).json({ error: validation.message });
        }

        let dateToFetch = new Date(); // Default is today's date

        // Parse the date filter
        if (date === 'yesterday') {
            dateToFetch.setDate(dateToFetch.getDate() - 1);
        } else if (date === 'tomorrow') {
            dateToFetch.setDate(dateToFetch.getDate() + 1);
        } else if (date === 'day_after_tomorrow') {
            dateToFetch.setDate(dateToFetch.getDate() + 2);
        }

        console.log(`Processing request for ${date} (${dateToFetch.toDateString()}), flight type: ${flightType}, direction: ${flightDirection}`);

        // Get flight data for the selected date and flight type
        const { totalFlights, flights } = await getFlightData(dateToFetch, flightType, flightDirection);

        // Process the flight data
        const flightStatuses = {
            on_time: flights.filter(flight => flight.status === 'on time').length,
            cancelled: flights.filter(flight => flight.status === 'cancelled').length,
            delayed: flights.filter(flight => flight.status === 'delayed').length,
        };

        // Extract unique airlines
        const airlines = [...new Set(flights.map(flight => flight.airline))].filter(Boolean);

        // Extract unique origins/destinations
        const locations = [...new Set(flights.map(flight => flight.location))].filter(Boolean);

        // Count flights by terminal and hour
        const flightCountByHour = {};
        flights.forEach(flight => {
            // Extract hour from time format like "18:25"
            const [hour] = flight.scheduledTime.split(':');
            const flightHour = parseInt(hour, 10);
            const isT3 = flight.terminal === 'T3';

            if (!isNaN(flightHour)) {
                if (!flightCountByHour[flightHour]) {
                    flightCountByHour[flightHour] = { T2: 0, T3: 0, total: 0 };
                }
                if (isT3) {
                    flightCountByHour[flightHour].T3 += 1;
                } else {
                    flightCountByHour[flightHour].T2 += 1;
                }
                flightCountByHour[flightHour].total += 1;
            }
        });

        // Calculate peak hours (max and min flights)
        let maxFlights = 0;
        let minFlights = Infinity;
        let maxHour = 0;
        let minHour = 0;

        // Set initial response structure
        const flightCountJSON = {
            airport: "Sydney Airport",
            date: formatDate(dateToFetch),
            flight_type: flightType,
            flight_direction: flightDirection,
            total_flights: totalFlights,
            flight_count: {},
            flight_statuses: flightStatuses,
            peak_hours: {
                max_flights: null,
                lowest_flights: null,
            },
            airlines: airlines,
            locations: locations,
            sample_flights: flights.slice(0, 5)
        };

        // Format the flight counts and calculate peak hours
        for (let hour = 0; hour < 24; hour++) {
            const count = flightCountByHour[hour]?.total || 0;
            flightCountJSON.flight_count[`${hour}-${hour + 1}`] = flightCountByHour[hour] || { T2: 0, T3: 0, total: 0 };

            if (count > maxFlights) {
                maxFlights = count;
                maxHour = hour;
            }

            if (count < minFlights && count > 0) {
                minFlights = count;
                minHour = hour;
            }
        }

        // Set peak hours
        flightCountJSON.peak_hours.max_flights = {
            hour: `${maxHour}-${maxHour + 1}`,
            count: maxFlights || 0
        };

        flightCountJSON.peak_hours.lowest_flights = {
            hour: `${minHour}-${minHour + 1}`,
            count: minFlights !== Infinity ? minFlights : 0
        };

        // Add metadata for caching and processing
        flightCountJSON.metadata = {
            processed_at: new Date().toISOString(),
            version: '1.0',
            source: 'sydney_airport_api'
        };

        // Send the final response with the structured data
        res.json(flightCountJSON);
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({
            error: 'Failed to fetch flight data',
            message: error.message || 'Unknown error',
            timestamp: new Date().toISOString()
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0'
    });
});

// Start the server
const server = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});