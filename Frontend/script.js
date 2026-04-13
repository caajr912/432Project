let chart; // global chart variable

function getStock(){

const ticker = document.getElementById("ticker").value.toUpperCase()

const data = {
    ticker: ticker,
    price: "$182.44",
    sentiment: "Positive",
    news:[
        "Apple releases new AI chip",
        "iPhone demand increases",
        "Investors bullish on Apple"
    ],
    prices:[120,180,140,100,185]
}

// UPDATE PRICE
document.getElementById("price").innerText = "Current Price: " + data.price


// NEWS (cards instead of bullets)
const newsList = document.getElementById("newsList")
newsList.innerHTML = ""

data.news.forEach(article=>{

    const div = document.createElement("div")
    div.className = "newsCard"
    div.innerText = article

    newsList.appendChild(div)

})


// CHART

const ctx = document.getElementById('stockChart').getContext('2d')

// destroy old chart before creating new one
if(chart){
    chart.destroy()
}

chart = new Chart(ctx, {
    type: 'line',
    data: {
        labels: ['Jan','Feb','Mar','Apr','May'],
        datasets: [{
            label: ticker + " Price",
            data: data.prices,
            borderColor: "#4f46e5",
            backgroundColor: "rgba(79,70,229,0.15)",
            tension: 0.4,
            fill: true,
            pointRadius: 4
        }]
    },
    options:{
        responsive:true,
        plugins:{
            legend:{display:false}
        },
        scales:{
            x:{grid:{display:false}},
            y:{grid:{color:"#e5e7eb"}}
        }
    }
})

}