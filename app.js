const express = require('express');
const puppeteer = require('puppeteer');
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

// Utility function to format the date as `YYYY/MM/DD`
const formatDate = (date) => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${year}/${month}/${day}`;
};

// Function to validate input parameters
const validateParams = (date, flightType) => {
    const validFlightTypes = ['domestic', 'international'];
    const validDates = ['today', 'yesterday', 'tomorrow', 'day_after_tomorrow'];

    if (flightType && !validFlightTypes.includes(flightType)) {
        return { isValid: false, message: 'Invalid flight type. Use "domestic" or "international".' };
    }

    if (date && !validDates.includes(date)) {
        return { isValid: false, message: 'Invalid date. Use "today", "yesterday", "tomorrow", or "day_after_tomorrow".' };
    }

    return { isValid: true };
};

// Function to get flight data with improved error handling
const getFlightTimes = async (date, flightType) => {
    const terminalType = flightType === 'domestic' ? 'domestic' : 'international';
    const formattedDate = formatDate(date);
    console.log(`Fetching ${terminalType} flights for ${formattedDate}`);

    const url = `https://www.sydneyairport.com.au/flights/?query=&flightType=arrival&terminalType=${terminalType}&date=${formattedDate}&sortColumn=scheduled_time&ascending=true&showAll=true`;

    let browser = null;
    try {
        // Launch browser with additional options for reliability
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();

        // Set timeout and user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setDefaultNavigationTimeout(90000); // 90 seconds

        // Navigate to the page
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Wait for selector with timeout
        const selectorResponse = await Promise.race([
            page.waitForSelector('.flight-card').then(() => ({ success: true })),
            new Promise(resolve => setTimeout(() => resolve({ success: false, error: 'Timeout waiting for flight data' }), 30000))
        ]);

        if (!selectorResponse.success) {
            throw new Error(selectorResponse.error);
        }

        // Extract flight data
        const flightData = await page.evaluate(() => {
            const flights = [];
            const flightCards = document.querySelectorAll('.flight-card');

            flightCards.forEach(card => {
                try {
                    // Get scheduled time
                    const scheduledTimeElement = card.querySelector('.middle-pane .times .latest-time div');

                    // Get flight number
                    const flightNumberElement = card.querySelector('.flight-number');

                    // Get origin location
                    const originElement = card.querySelector('.origin-destination');

                    // Get status - improved status detection
                    const statusContainer = card.querySelector('.status-container');
                    const statusElement = statusContainer ? statusContainer.querySelector('.status') : null;
                    let status = 'on time'; // default status

                    if (statusElement) {
                        const statusText = statusElement.textContent.trim().toLowerCase();
                        const hasRedClass = statusElement.classList.contains('red');

                        // Check for cancelled flights
                        if (statusText.includes('cancelled') || hasRedClass) {
                            status = 'cancelled';
                        }
                        // Check for delayed flights
                        else if (statusText.includes('delayed') ||
                            statusElement.classList.contains('amber') ||
                            card.querySelector('.delayed-time-small')) {
                            status = 'delayed';
                        }
                    }

                    // Get airline
                    const airlineElement = card.querySelector('.airline-logo span.with-image');

                    const scheduledTime = scheduledTimeElement ? scheduledTimeElement.textContent.trim() : '';
                    const airline = airlineElement ? airlineElement.textContent.trim().toLowerCase() : '';
                    const flightNumber = flightNumberElement ? flightNumberElement.textContent.trim() : '';
                    const origin = originElement ? originElement.textContent.trim() : '';

                    flights.push({
                        scheduledTime,
                        status,
                        airline,
                        flightNumber,
                        origin,
                        rawStatus: statusElement ? statusElement.textContent.trim() : 'Unknown' // for debugging
                    });
                } catch (err) {
                    // Skip problematic flight cards but log error info
                    console.error('Error processing flight card:', err);
                }
            });
            return flights;
        });

        // Close browser
        await browser.close();
        browser = null;

        // Debug log to check status distribution
        const statusCount = flightData.reduce((acc, flight) => {
            acc[flight.status] = (acc[flight.status] || 0) + 1;
            return acc;
        }, {});
        console.log('Status distribution:', statusCount);
        console.log(`Total flights found: ${flightData.length}`);

        return flightData;
    } catch (error) {
        console.error('Error fetching flight data:', error);
        // Ensure browser is closed in case of error
        if (browser) {
            await browser.close();
        }
        throw error;
    }
};

// Endpoint to get flight data based on selected filters
app.get('/api/flights', async (req, res) => {
    try {
        const { date = 'today', flightType = 'domestic' } = req.query;

        // Validate parameters
        const validation = validateParams(date, flightType);
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

        console.log(`Processing request for ${date} (${dateToFetch.toDateString()}), flight type: ${flightType}`);

        // Get flight data for the selected date and flight type (domestic/international)
        const flightData = await getFlightTimes(dateToFetch, flightType);

        // Process the flight data
        const flightStatuses = {
            on_time: flightData.filter(flight => flight.status === 'on time').length,
            cancelled: flightData.filter(flight => flight.status === 'cancelled').length,
            delayed: flightData.filter(flight => flight.status === 'delayed').length,
        };

        // Extract unique airlines
        const airlines = [...new Set(flightData.map(flight => flight.airline))].filter(Boolean);

        // Extract unique origins
        const origins = [...new Set(flightData.map(flight => flight.origin))].filter(Boolean);

        // Count flights by terminal and hour
        const flightCountByHour = {};
        flightData.forEach(flight => {
            const [hour] = flight.scheduledTime.split(':');
            const flightHour = parseInt(hour, 10);
            const isT3 = flight.airline.includes('qantas');

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

        const flightCountJSON = {
            airport: "Sydney Airport",
            date: formatDate(dateToFetch),
            flight_type: flightType,
            total_flights: flightData.length,
            flight_count: {},
            flight_statuses: flightStatuses,
            peak_hours: {
                max_flights: null,
                lowest_flights: null,
            },
            airlines: airlines,
            origins: origins,
            // Include sample of raw flight data for debugging
            sample_flights: flightData.slice(0, 5)
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
            count: maxFlights
        };

        flightCountJSON.peak_hours.lowest_flights = {
            hour: `${minHour}-${minHour + 1}`,
            count: minFlights
        };

        // Add metadata for caching and processing
        flightCountJSON.metadata = {
            processed_at: new Date().toISOString(),
            version: '1.1'
        };

        // Send the final response with the structured data
        res.json(flightCountJSON);
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({
            error: 'Failed to fetch flight data',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.1'
    });
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});